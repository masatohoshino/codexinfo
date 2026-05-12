#!/usr/bin/env node
/**
 * codexinfo-hook — Codex hook runner (notify path + optional PermissionRequest).
 *
 * Default path (registered via notify = [...] in ~/.codex/config.toml):
 *   Codex passes the event payload as JSON in argv[2].
 *
 * Approval-wait path (registered as [[hooks.PermissionRequest]]):
 *   Codex delivers the payload via stdin.
 *
 * Exit 0 always — never interfere with Codex.
 * No external npm dependencies — only Node.js built-ins.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, open, readdir, writeFile, stat, rm } from "node:fs/promises";
import { request } from "node:http";

const DEBUG = process.env["CODEXINFO_DEBUG"] === "1";
function dbg(...args) { if (DEBUG) process.stderr.write("[codexinfo-hook] " + args.join(" ") + "\n"); }
function sha256(s) { return createHash("sha256").update(String(s)).digest("hex"); }

const CONFIG_PATH = process.env["CODEXINFO_HOOK_CONFIG_PATH"] || join(homedir(), ".openclaw", "codexinfo", "hook-config.json");

function resolveDedupeDir() {
  const xdg = process.env["XDG_CACHE_HOME"];
  if (xdg) return join(xdg, "codexinfo", "dedupe");
  const localAppData = process.env["LOCALAPPDATA"];
  if (localAppData) return join(localAppData, "codexinfo", "dedupe");
  return join(homedir(), ".cache", "codexinfo", "dedupe");
}
const DEDUPE_DIR = resolveDedupeDir();
const STOP_TTL_MS = 10 * 60 * 1000;    // 10 min TTL — turn-id / thread-id based keys
const WINDOW_TTL_MS = 10 * 1000;       // 10 sec TTL — VS Code per-cwd coalescing window
const PERM_TTL_MS = 2 * 60 * 1000;    // 2 min TTL — PermissionRequest
const APPROVAL_CWD_WINDOW_TTL_MS = 30_000; // 30s — coalesces PermReq + Path D double-fire
const ROLLOUT_TAIL_BYTES = 4096;
const ROLLOUT_MAX_AGE_MS = 10 * 60 * 1000;

function readHookConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return null;
  }
}

async function readStdinJson() {
  return new Promise((resolve) => {
    let data = "";
    const timer = setTimeout(() => resolve(null), 3000);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(data)); } catch { resolve(null); }
    });
    process.stdin.on("error", () => { clearTimeout(timer); resolve(null); });
    // If stdin is a tty (interactive), resolve immediately with argv fallback
    if (process.stdin.isTTY) { clearTimeout(timer); resolve(null); }
  });
}

// Build ordered dedupe key list for a completion event.
// [{type, key, ttl, atomic}] where the first atomic=true entry is claimed with O_EXCL.
// Key order: turn_id (primary/atomic) → window (VS Code coalescing, client-gated).
function buildCompletionDedupeKeys(payload) {
  const turnId = payload["turn_id"] ?? payload["turn-id"];
  const cwd = String(payload["cwd"] ?? "");
  const client = String(payload["client"] ?? "");
  const cwdHash = sha256(cwd);
  const keys = [];

  if (turnId) {
    keys.push({
      type: "turn_id",
      key: sha256(`codexinfo:v1:completion:turn:${turnId}`),
      ttl: STOP_TTL_MS,
      atomic: true,
    });
  }

  // Window key: VS Code fires notify multiple times per logical task; only cwd+client is stable.
  // Not applied to CLI payloads (no client field) to avoid false-positives on rapid sequential turns.
  if (client) {
    keys.push({
      type: "window",
      key: sha256(`codexinfo:v1:completion:window:${client}:${cwdHash}`),
      ttl: WINDOW_TTL_MS,
      atomic: !turnId,
    });
  }

  // Fallback: cwd + client + 60 s window — degenerate payloads with no usable identity.
  if (keys.length === 0) {
    const tsBucket60 = Math.floor(Date.now() / 60000).toString();
    keys.push({
      type: "fallback",
      key: sha256(`codexinfo:v1:completion:fallback:${cwdHash}:${client}:${tsBucket60}`),
      ttl: 60 * 1000,
      atomic: true,
    });
  }

  return keys;
}

// Multi-key dedupe for completion events.
// Strategy: check secondaries (thread_cwd, window) first via stat, then atomically claim primary.
// After claiming primary, write secondary flags to block VS Code re-fires within the window TTL.
// Returns {duplicate: boolean, by?: string}.
async function isCompletionDuplicate(payload) {
  await mkdir(DEDUPE_DIR, { recursive: true });
  const keys = buildCompletionDedupeKeys(payload);
  const primaryIdx = keys.findIndex((k) => k.atomic);
  const primary = keys[primaryIdx];
  const secondaries = keys.filter((_, i) => i !== primaryIdx);

  // Pass 1: Check secondary flags (stat only; VS Code double-fire is ~1–2 s apart).
  for (const { key, ttl, type } of secondaries) {
    const p = join(DEDUPE_DIR, `${key}.flag`);
    try {
      const s = await stat(p);
      if (Date.now() - s.mtimeMs <= ttl) return { duplicate: true, by: type };
      await rm(p, { force: true }).catch(() => {});
    } catch { /* absent */ }
  }

  // Pass 2: Check then atomically claim primary flag.
  const primaryPath = join(DEDUPE_DIR, `${primary.key}.flag`);
  try {
    const s = await stat(primaryPath);
    if (Date.now() - s.mtimeMs <= primary.ttl) return { duplicate: true, by: primary.type };
    await rm(primaryPath, { force: true }).catch(() => {});
  } catch { /* absent — proceed to claim */ }

  try {
    await writeFile(primaryPath, "1", { flag: "wx" }); // atomic O_EXCL
  } catch (err) {
    if (err?.code === "EEXIST") return { duplicate: true, by: primary.type };
    return { duplicate: false }; // unexpected error — don't suppress
  }

  // Claimed. Write secondary flags to block the VS Code second-fire (different turn-id).
  for (const { key } of secondaries) {
    await writeFile(join(DEDUPE_DIR, `${key}.flag`), "1").catch(() => {});
  }

  return { duplicate: false };
}

// Single-key atomic dedupe for PermissionRequest (and cwd-window coalescing).
async function isPermDuplicate(key, ttlMs = PERM_TTL_MS) {
  await mkdir(DEDUPE_DIR, { recursive: true });
  const flagPath = join(DEDUPE_DIR, `${key}.flag`);
  try {
    try {
      const s = await stat(flagPath);
      if (Date.now() - s.mtimeMs <= ttlMs) return true;
      await rm(flagPath, { force: true }).catch(() => {});
    } catch { /* absent */ }
    await writeFile(flagPath, "1", { flag: "wx" });
    return false;
  } catch (err) {
    if (err?.code === "EEXIST") return true;
    return false;
  }
}

function buildApprovalCwdWindowKey(cwd) {
  return sha256(`codexinfo:v1:approval-cwd-window:${sha256(cwd)}`);
}

function buildDedupeKeyForPermissionRequest(payload) {
  const turnId = payload["turn_id"] ?? payload["turn-id"];
  const toolUseId = payload["tool_use_id"] ?? payload["tool-use-id"];
  const toolName = typeof payload["tool_name"] === "string" ? payload["tool_name"] : "";
  // Best: turn-scoped + unique tool invocation id
  if (turnId && toolUseId) {
    return createHash("sha256").update(`perm:${turnId}:${toolUseId}`).digest("hex");
  }
  // Good: turn-scoped + tool identity
  if (turnId) {
    const inputStr = JSON.stringify(payload["tool_input"] ?? {});
    return createHash("sha256").update(`perm:${turnId}:${toolName}:${inputStr}`).digest("hex");
  }
  // Fallback: session + tool + time bucket
  const sessionId = payload["session_id"] ?? payload["thread-id"] ?? payload["thread_id"] ?? "";
  const inputStr = JSON.stringify(payload["tool_input"] ?? {});
  const tsBucket = Math.floor(Date.now() / PERM_TTL_MS).toString();
  return createHash("sha256").update(`perm:${sessionId}:${toolName}:${inputStr}:${tsBucket}`).digest("hex");
}

function findCodexBin() {
  const fallbacks = [
    `${homedir()}/.npm-global/bin/codex`,
    `${homedir()}/.local/bin/codex`,
    `/usr/local/bin/codex`,
  ];
  for (const p of fallbacks) {
    try { if (existsSync(p)) return p; } catch { /* skip */ }
  }
  return "codex"; // rely on PATH; ENOENT caught by spawn error handler
}

// Scan today's rollout directory for a rollout whose session_meta cwd matches the given cwd.
// Returns the rollout file path, or null if not found.
async function findRolloutForCwd(cwd, nowMs) {
  if (!cwd) return null;
  const d = new Date(nowMs ?? Date.now());
  const pad = (n) => String(n).padStart(2, "0");
  const dateDir = `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`;
  const sessionsDir = join(homedir(), ".codex", "sessions", dateDir);
  let files;
  try { files = await readdir(sessionsDir); } catch { return null; }
  const rollouts = files
    .filter((f) => f.startsWith("rollout-") && f.endsWith(".jsonl"))
    .sort()
    .reverse();
  for (const fname of rollouts.slice(0, 5)) {
    const tsMatch = fname.match(/^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/);
    if (tsMatch) {
      const [, yr, mo, dy, hr, mn, sc] = tsMatch;
      const fileTs = Date.UTC(+yr, +mo - 1, +dy, +hr, +mn, +sc);
      if ((nowMs ?? Date.now()) - fileTs > ROLLOUT_MAX_AGE_MS) break;
    }
    const fpath = join(sessionsDir, fname);
    let fh;
    try {
      fh = await open(fpath, "r");
      const buf = Buffer.alloc(200);
      const { bytesRead } = await fh.read(buf, 0, 200, 0);
      const header = buf.toString("utf8", 0, bytesRead);
      const m = header.match(/"cwd":"((?:[^"\\]|\\.)*)"/);
      if (m?.[1] === cwd) return fpath;
    } catch { /* skip */ } finally {
      await fh?.close().catch(() => {});
    }
  }
  return null;
}

// Read the tail of a rollout JSONL and classify as "approval-wait" or "completion".
// approval-wait: has function_call with no following function_call_output and no task_complete.
// Returns { result: "approval-wait" | "completion", toolName?: string }.
async function classifyRolloutApprovalWait(rolloutPath) {
  let fh;
  try {
    fh = await open(rolloutPath, "r");
    const { size } = await fh.stat();
    const readSize = Math.min(ROLLOUT_TAIL_BYTES, size);
    const buf = Buffer.alloc(readSize);
    await fh.read(buf, 0, readSize, size - readSize);
    const lines = buf.toString("utf8").split("\n");
    let hasTaskComplete = false;
    let hasPendingFunctionCall = false;
    let pendingToolName = undefined;
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try {
        const obj = JSON.parse(t);
        const type = obj?.type;
        const pt = obj?.payload?.type;
        if (type === "event_msg" && pt === "task_complete") hasTaskComplete = true;
        if (type === "response_item" && pt === "function_call") {
          hasPendingFunctionCall = true;
          pendingToolName = typeof obj?.payload?.name === "string" ? obj.payload.name : undefined;
        }
        if (type === "response_item" && pt === "function_call_output") {
          hasPendingFunctionCall = false;
          pendingToolName = undefined;
        }
      } catch { /* incomplete JSON at tail boundary — skip */ }
    }
    if (hasTaskComplete) return { result: "completion" };
    if (hasPendingFunctionCall) return { result: "approval-wait", toolName: pendingToolName };
  } catch { /* any error → fallback */ } finally {
    await fh?.close().catch(() => {});
  }
  return { result: "completion" };
}

async function probeRateLimits() {
  const codexBin = findCodexBin();

  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const timer = setTimeout(() => { proc?.kill(); done(null); }, 6000);

    let proc;
    try {
      proc = spawn(codexBin, ["app-server"], { stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      clearTimeout(timer);
      return done(null);
    }

    if (!proc.stdin || !proc.stdout) { clearTimeout(timer); return done(null); }

    let buf = "";
    const replies = new Map();

    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        try {
          const msg = JSON.parse(t);
          if (typeof msg.id === "number" && replies.has(msg.id)) {
            const cb = replies.get(msg.id);
            replies.delete(msg.id);
            cb(msg);
          }
        } catch { /* ignore */ }
      }
    });

    proc.on("error", () => { clearTimeout(timer); done(null); });
    proc.on("close", () => { clearTimeout(timer); done(null); });

    const send = (msg) => {
      try { proc.stdin.write(JSON.stringify(msg) + "\n"); } catch { /* ignore */ }
    };

    const waitForId = (id, ms) => new Promise((res) => {
      const t = setTimeout(() => { replies.delete(id); res(null); }, ms);
      replies.set(id, (msg) => { clearTimeout(t); res(msg); });
    });

    (async () => {
      try {
        send({ id: 1, method: "initialize", params: { clientInfo: { name: "codexinfo", version: "0.1.0" } } });
        const init = await waitForId(1, 1500);
        if (!init) return done(null);

        send({ method: "initialized", params: {} });
        send({ id: 2, method: "account/rateLimits/read", params: {} });
        const resp = await waitForId(2, 2500);
        if (!resp?.result) return done(null);

        const result = resp.result;
        const buckets = [];
        const secToIso = (s) => new Date(s * 1000).toISOString();
        const winLabel = (mins) => {
          if (mins == null) return "W";
          if (mins >= 7 * 24 * 60) return "W";
          if (mins >= 60) return `${Math.floor(mins / 60)}h`;
          return `${mins}m`;
        };

        const byId = result.rateLimitsByLimitId ?? {};
        for (const snap of Object.values(byId)) {
          for (const win of ["primary", "secondary"]) {
            const w = snap?.[win];
            if (w && typeof w.usedPercent === "number") {
              buckets.push({
                windowLabel: winLabel(w.windowDurationMins),
                usedPercent: Math.round(w.usedPercent),
                resetsAt: typeof w.resetsAt === "number" ? secToIso(w.resetsAt) : null,
              });
            }
          }
        }

        if (buckets.length === 0) {
          const rl = result.rateLimits ?? {};
          for (const win of ["primary", "secondary"]) {
            const w = rl[win];
            if (w && typeof w.usedPercent === "number") {
              buckets.push({
                windowLabel: winLabel(w.windowDurationMins),
                usedPercent: Math.round(w.usedPercent),
                resetsAt: typeof w.resetsAt === "number" ? secToIso(w.resetsAt) : null,
              });
            }
          }
        }

        done(buckets.length > 0 ? { displayMode: "left", buckets } : null);
      } catch {
        done(null);
      } finally {
        try { proc.stdin?.end(); proc.kill(); } catch { /* ignore */ }
        clearTimeout(timer);
      }
    })();
  });
}

async function postToGateway(cfg, event, extra) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ source: "codex", event, ...extra });
    const url = new URL(`${cfg.gatewayUrl}/plugins/codexinfo/hook`);
    const options = {
      method: "POST",
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        Authorization: `Bearer ${cfg.token}`,
      },
      timeout: 5000,
    };
    const req = request(options, (res) => { res.resume(); dbg("gateway event=" + event + " status=" + res.statusCode); resolve(res.statusCode === 200); });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.write(body);
    req.end();
  });
}

async function main() {
  const cfg = readHookConfig();
  if (!cfg?.gatewayUrl || !cfg?.token) {
    process.exit(0); // not configured — silent exit
  }

  // Notify path: Codex passes JSON in argv[2] — check it first to avoid 3-second stdin wait.
  // Structured hook path (PermissionRequest): Codex sends JSON via stdin.
  let payload = null;
  if (process.argv[2]) {
    try { payload = JSON.parse(process.argv[2]); } catch { /* fall through to stdin */ }
  }
  if (!payload) {
    payload = await readStdinJson();
  }
  if (!payload || typeof payload !== "object") {
    process.exit(0);
  }

  const hookEvent = payload["hook_event_name"]; // structured hooks: "Stop", "PermissionRequest"
  const legacyEvent = payload["type"] ?? payload["event"]; // legacy notify: "agent-turn-complete"

  let eventType;
  if (hookEvent === "Stop" || legacyEvent === "agent-turn-complete") {
    eventType = "completion";
  } else if (hookEvent === "PermissionRequest") {
    eventType = "approval-wait";
  } else {
    process.exit(0);
  }

  const payloadSource = process.argv[2] ? "argv" : "stdin";
  const _turnId = payload["turn_id"] ?? payload["turn-id"];
  const _threadId = payload["session_id"] ?? payload["thread_id"] ?? payload["thread-id"];
  const _cwd = String(payload["cwd"] ?? "");
  dbg(
    "invocation",
    "event=" + eventType,
    "source=notify",
    "payload_source=" + payloadSource,
    "hook=" + (hookEvent ?? legacyEvent ?? "?"),
    "turn_id_hash=" + (_turnId ? sha256(String(_turnId)).slice(0, 12) : "absent"),
    "thread_id_hash=" + (_threadId ? sha256(String(_threadId)).slice(0, 12) : "absent"),
    "cwd_hash=" + sha256(_cwd).slice(0, 12)
  );

  // Path D: rollout JSONL reclassification — VS Code fires notify at function_call time.
  // When rollout shows function_call without task_complete, reclassify completion→approval-wait.
  const _client = String(payload["client"] ?? "");
  let reclassifiedAsApprovalWait = false;
  let rolloutToolName = null;
  if (eventType === "completion" && _client) {
    const rolloutPath = await findRolloutForCwd(_cwd, Date.now());
    if (rolloutPath) {
      const { result: rolloutClass, toolName } = await classifyRolloutApprovalWait(rolloutPath);
      dbg("rollout=" + rolloutClass + " file=" + rolloutPath.split("/").slice(-1)[0]);
      if (rolloutClass === "approval-wait") {
        eventType = "approval-wait";
        reclassifiedAsApprovalWait = true;
        rolloutToolName = toolName ?? null;
        const raKey = sha256(`codexinfo:v1:rollout-approval:${sha256(_cwd)}`);
        if (await isPermDuplicate(raKey)) {
          dbg("dedupe=skip rollout-approval");
          process.exit(0);
        }
        // Suppress if PermissionRequest hook already sent a notification for this cwd within 30s.
        const cwdWinKey = buildApprovalCwdWindowKey(_cwd);
        if (await isPermDuplicate(cwdWinKey, APPROVAL_CWD_WINDOW_TTL_MS)) {
          dbg("dedupe=skip approval-cwd-window (PermReq already sent)");
          process.exit(0);
        }
        dbg("dedupe=send rollout-approval tool=" + (rolloutToolName ?? "unknown"));
      }
    } else {
      dbg("rollout=not-found fallback=completion");
    }
  }

  // Dedupe: suppress duplicate invocations.
  // VS Code Codex extension fires notify twice per turn with DIFFERENT turn-ids;
  // a content-hash secondary key catches these even when turn-ids differ.
  if (!reclassifiedAsApprovalWait) {
    if (eventType === "completion") {
      const { duplicate, by } = await isCompletionDuplicate(payload);
      if (duplicate) {
        dbg("dedupe=skip event=completion by=" + (by ?? "?"));
        process.exit(0);
      }
      const keys = buildCompletionDedupeKeys(payload);
      const primary = keys.find((k) => k.atomic);
      dbg("dedupe=send event=completion primary=" + (primary?.type ?? "?") + " key=" + (primary?.key ?? "").slice(0, 16));
    } else if (eventType === "approval-wait") {
      const key = buildDedupeKeyForPermissionRequest(payload);
      if (await isPermDuplicate(key)) {
        dbg("dedupe=skip event=approval-wait key=" + key.slice(0, 16));
        process.exit(0);
      }
      // Claim the cwd-window so Path D rollout-reclassification won't double-fire.
      await isPermDuplicate(buildApprovalCwdWindowKey(_cwd), APPROVAL_CWD_WINDOW_TTL_MS);
      dbg("dedupe=send event=approval-wait key=" + key.slice(0, 16));
    }
  }

  const usage = await probeRateLimits();

  if (eventType === "completion") {
    await postToGateway(cfg, "agent-turn-complete", usage ? { usage } : {});
    if (usage?.buckets?.some((b) => b.usedPercent >= 100)) {
      await postToGateway(cfg, "rate-limit-reached", { usage });
    }
  } else if (eventType === "approval-wait") {
    // PermissionRequest path: payload has tool_name/tool_input from Codex.
    // Rollout-reclassified path: use tool name extracted from rollout; no tool_input available.
    const toolName = payload["tool_name"] ?? rolloutToolName ?? null;
    const toolInput = typeof payload["tool_input"] === "object" ? payload["tool_input"] : null;
    await postToGateway(cfg, "permission-request", {
      tool_name: toolName,
      ...(toolInput ? { tool_input: toolInput } : {}),
      ...(usage ? { usage } : {}),
    });
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
