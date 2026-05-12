import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { CodexInfoEvent, UsageSnapshot } from "./types.js";

const DEFAULT_JOURNAL_DIR = join(homedir(), ".openclaw", "codexinfo-journal");

function journalFilePath(dir: string, receivedAt: string): string {
  const date = receivedAt.slice(0, 10);
  return join(dir, `${date}.jsonl`);
}

function hashSession(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

function buildRateLimitsEntry(usage: UsageSnapshot): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const KEY: Record<string, string> = { "5h": "fiveHour", W: "weekly", "1h": "oneHour", D: "daily" };
  for (const b of usage.buckets) {
    const key = KEY[b.windowLabel] ?? b.windowLabel;
    const entry: Record<string, unknown> = {
      leftPercent: 100 - b.usedPercent,
    };
    if (b.resetsAt != null) entry["resetsAt"] = b.resetsAt;
    out[key] = entry;
  }
  return out;
}

export function buildJournalEntry(event: CodexInfoEvent): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    t: event.receivedAt,
    agent: "codex",
    event: event.eventType,
  };

  if (event.eventType === "approval-wait" || event.eventType === "rate-limit-reached") {
    entry["needsUser"] = true;
  }

  if (event.eventType === "approval-wait" && event.approval) {
    entry["approval"] = { promptText: event.approval.descriptionLine };
  }

  if (event.usage && event.usage.buckets.length > 0) {
    entry["rateLimits"] = buildRateLimitsEntry(event.usage);
  }

  return entry;
}

export function writeJournalEntry(
  event: CodexInfoEvent,
  dir: string = DEFAULT_JOURNAL_DIR,
): void {
  const entry = buildJournalEntry(event);
  const filePath = journalFilePath(dir, event.receivedAt);
  const line = JSON.stringify(entry) + "\n";

  mkdir(dir, { recursive: true })
    .then(() => appendFile(filePath, line, "utf8"))
    .catch(() => {
      /* non-blocking best-effort */
    });
}
