import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { UsageBucket, UsageSnapshot } from "./types.js";

const FALLBACK_CODEX_BINS = [
  `${process.env["HOME"] ?? "~"}/.npm-global/bin/codex`,
  `${process.env["HOME"] ?? "~"}/.local/bin/codex`,
  `/usr/local/bin/codex`,
];

function findCodexBin(): string {
  for (const p of FALLBACK_CODEX_BINS) {
    if (existsSync(p)) return p;
  }
  return "codex"; // rely on PATH; ENOENT will be caught by proc.on("error")
}

function secToIso(secs: number): string {
  return new Date(secs * 1000).toISOString();
}

function windowLabel(windowDurationMins: number | null | undefined): string {
  if (windowDurationMins == null) return "W";
  if (windowDurationMins >= 7 * 24 * 60) return "W";
  if (windowDurationMins >= 60) return `${Math.floor(windowDurationMins / 60)}h`;
  return `${windowDurationMins}m`;
}

function buildBuckets(
  rateLimitsByLimitId: Record<string, unknown> | null | undefined,
  rateLimits: Record<string, unknown> | null | undefined,
): UsageBucket[] {
  const buckets: UsageBucket[] = [];

  const byId = rateLimitsByLimitId ?? {};
  for (const snapshot of Object.values(byId)) {
    if (typeof snapshot !== "object" || snapshot === null) continue;
    const s = snapshot as Record<string, unknown>;
    const primary = s["primary"] as Record<string, unknown> | null | undefined;
    if (primary) {
      const usedPct = typeof primary["usedPercent"] === "number" ? primary["usedPercent"] : null;
      if (usedPct !== null) {
        buckets.push({
          windowLabel: windowLabel(primary["windowDurationMins"] as number | null),
          usedPercent: Math.round(usedPct),
          resetsAt:
            typeof primary["resetsAt"] === "number" ? secToIso(primary["resetsAt"]) : null,
        });
      }
    }
    const secondary = s["secondary"] as Record<string, unknown> | null | undefined;
    if (secondary) {
      const usedPct = typeof secondary["usedPercent"] === "number" ? secondary["usedPercent"] : null;
      if (usedPct !== null) {
        buckets.push({
          windowLabel: windowLabel(secondary["windowDurationMins"] as number | null),
          usedPercent: Math.round(usedPct),
          resetsAt:
            typeof secondary["resetsAt"] === "number"
              ? secToIso(secondary["resetsAt"])
              : null,
        });
      }
    }
  }

  if (buckets.length === 0 && rateLimits) {
    const rl = rateLimits as Record<string, unknown>;
    const primary = rl["primary"] as Record<string, unknown> | null | undefined;
    if (primary && typeof primary["usedPercent"] === "number") {
      buckets.push({
        windowLabel: windowLabel(primary["windowDurationMins"] as number | null),
        usedPercent: Math.round(primary["usedPercent"]),
        resetsAt:
          typeof primary["resetsAt"] === "number" ? secToIso(primary["resetsAt"]) : null,
      });
    }
    const secondary = rl["secondary"] as Record<string, unknown> | null | undefined;
    if (secondary && typeof secondary["usedPercent"] === "number") {
      buckets.push({
        windowLabel: windowLabel(secondary["windowDurationMins"] as number | null),
        usedPercent: Math.round(secondary["usedPercent"]),
        resetsAt:
          typeof secondary["resetsAt"] === "number" ? secToIso(secondary["resetsAt"]) : null,
      });
    }
  }

  return buckets;
}

export async function probeRateLimits(): Promise<UsageSnapshot | null> {
  const codexBin = findCodexBin();

  return new Promise((resolve) => {
    let settled = false;
    const done = (result: UsageSnapshot | null) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };

    let proc: ReturnType<typeof spawn> | null = null;
    const overallTimeout = setTimeout(() => {
      proc?.kill();
      done(null);
    }, 6000);

    try {
      proc = spawn(codexBin, ["app-server"], {
        stdio: ["pipe", "pipe", "ignore"],
      });

      const stdout = proc.stdout;
      if (!stdout || !proc.stdin) {
        clearTimeout(overallTimeout);
        done(null);
        return;
      }

      let buffer = "";
      const pendingReplies = new Map<number, (msg: unknown) => void>();

      const send = (msg: unknown) => {
        try {
          proc!.stdin!.write(JSON.stringify(msg) + "\n");
        } catch {
          /* ignore */
        }
      };

      const waitForId = (id: number, timeoutMs: number): Promise<unknown> =>
        new Promise((res) => {
          const t = setTimeout(() => {
            pendingReplies.delete(id);
            res(null);
          }, timeoutMs);
          pendingReplies.set(id, (msg) => {
            clearTimeout(t);
            res(msg);
          });
        });

      stdout.setEncoding("utf8");
      stdout.on("data", (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const msg = JSON.parse(trimmed) as Record<string, unknown>;
            const id = msg["id"];
            if (typeof id === "number" && pendingReplies.has(id)) {
              pendingReplies.get(id)!(msg);
              pendingReplies.delete(id);
            }
          } catch {
            /* ignore malformed lines */
          }
        }
      });

      proc.on("error", () => {
        clearTimeout(overallTimeout);
        done(null);
      });
      proc.on("close", () => {
        clearTimeout(overallTimeout);
        done(null);
      });

      (async () => {
        try {
          send({ id: 1, method: "initialize", params: { clientInfo: { name: "codexinfo", version: "0.1.0" } } });
          const initReply = await waitForId(1, 1500);
          if (!initReply) return done(null);

          send({ method: "initialized", params: {} });

          send({ id: 2, method: "account/rateLimits/read", params: {} });
          const limitsReply = await waitForId(2, 2500);
          if (!limitsReply) return done(null);

          const result = (limitsReply as Record<string, unknown>)["result"] as
            | Record<string, unknown>
            | null
            | undefined;
          if (!result) return done(null);

          const buckets = buildBuckets(
            result["rateLimitsByLimitId"] as Record<string, unknown> | null,
            result["rateLimits"] as Record<string, unknown> | null,
          );

          done(buckets.length > 0 ? { displayMode: "left", buckets } : null);
        } catch {
          done(null);
        } finally {
          try {
            proc?.stdin?.end();
            proc?.kill();
          } catch {
            /* ignore */
          }
          clearTimeout(overallTimeout);
        }
      })();
    } catch {
      clearTimeout(overallTimeout);
      done(null);
    }
  });
}

export function isRateLimitReached(usage: UsageSnapshot): boolean {
  return usage.buckets.some((b) => b.usedPercent >= 100);
}
