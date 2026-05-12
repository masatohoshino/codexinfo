#!/usr/bin/env node
/**
 * codexinfo — self-contained bootstrap CLI.
 *
 * Runs WITHOUT the OpenClaw plugin being installed.
 * Handles: setup, doctor, status, uninstall.
 *
 * After setup, full CLI is also available as:
 *   openclaw codexinfo <subcommand>
 *
 * No external npm dependencies — only Node.js built-ins.
 */
import { execFile as execFileCb } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const execFile = promisify(execFileCb);

const __filename = fileURLToPath(import.meta.url);
const PKG_ROOT = join(dirname(__filename), "..");
const HOOK_RUNNER = join(PKG_ROOT, "bin", "codexinfo-hook.js");

const OPENCLAW_DIR = join(homedir(), ".openclaw", "codexinfo");
const HOOK_CONFIG_PATH = join(OPENCLAW_DIR, "hook-config.json");
const PLUGIN_CONFIG_PATH = join(OPENCLAW_DIR, "config.json");
const MANIFEST_PATH = join(OPENCLAW_DIR, "manifest.json");
const CODEX_CONFIG_PATH = join(homedir(), ".codex", "config.toml");
const CLAUDE_SETTINGS_PATH = join(homedir(), ".claude", "settings.json");

const CODEX_MIN = "0.130.0";
const DEFAULT_GATEWAY = "http://localhost:3000";

const MARKER_BEGIN = "# codexinfo-begin";
const MARKER_END = "# codexinfo-end";

// ─── args ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const subcommand = argv.find((a) => !a.startsWith("-")) ?? "help";
const flags = {
  yes: argv.includes("--yes") || argv.includes("-y"),
  dryRun: argv.includes("--dry-run"),
  noJournal: argv.includes("--no-journal"),
  noApprovalWait: argv.includes("--no-approval-wait"),
  notify: argv.includes("--notify"),
  force: argv.includes("--force"),
  channels: argv.flatMap((a, i) => {
    if (a === "--channel" && argv[i + 1]) return [argv[i + 1]];
    if (a.startsWith("--channel=")) return [a.slice("--channel=".length)];
    return [];
  }),
  gatewayUrl: (() => {
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === "--gateway-url" && argv[i + 1]) return argv[i + 1];
      if (argv[i]?.startsWith("--gateway-url=")) return argv[i].slice("--gateway-url=".length);
    }
    return DEFAULT_GATEWAY;
  })(),
};

// ─── utilities ───────────────────────────────────────────────────────────────

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (a) => { rl.close(); resolve(a.trim()); });
  });
}

async function detectCodexVersion() {
  try {
    const { stdout } = await execFile("codex", ["--version"], { timeout: 5000, shell: true });
    const m = stdout.match(/(\d+\.\d+\.\d+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function meetsMinVersion(v, min) {
  const p = (s) => s.split(".").map(Number);
  const [ma, mi, pa] = p(v);
  const [mma, mmi, mpa] = p(min);
  if (ma !== mma) return ma > mma;
  if (mi !== mmi) return mi > mmi;
  return pa >= mpa;
}

function quoteForToml(s) {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// ─── TOML helpers ─────────────────────────────────────────────────────────────

/** "none" | "codexinfo" | "ext-agent-beta2" | "unknown" */
function detectNotifyKind(toml) {
  if (!/^notify\s*=/m.test(toml)) return "none";
  if (/^notify\s*=\s*\[.*codexinfo-hook\.js.*\]/m.test(toml)) return "codexinfo";
  if (/^notify\s*=\s*\[.*hook_helper\.py.*\]/m.test(toml)) return "ext-agent-beta2";
  return "unknown";
}

function buildNotifyLine(nodeExec, hookPath) {
  return `# codexinfo notify\nnotify = [${quoteForToml(nodeExec)}, ${quoteForToml(hookPath)}]\n`;
}

function insertNotifyAtTopLevel(toml, notifyLine) {
  const sectionMatch = toml.match(/^(\[|\[\[)/m);
  if (sectionMatch?.index !== undefined) {
    const before = toml.slice(0, sectionMatch.index).replace(/\n+$/, "");
    const after = toml.slice(sectionMatch.index);
    return (before ? before + "\n\n" : "") + notifyLine + "\n\n" + after;
  }
  const trimmed = toml.replace(/\n*$/, "");
  return (trimmed ? trimmed + "\n\n" : "") + notifyLine + "\n";
}

function buildPermissionRequestBlock(command) {
  const cmd = quoteForToml(command);
  return [
    MARKER_BEGIN,
    "[[hooks.PermissionRequest]]",
    "",
    "[[hooks.PermissionRequest.hooks]]",
    `type    = "command"`,
    `command = ${cmd}`,
    "timeout = 30",
    MARKER_END,
    "",
  ].join("\n");
}

function ensureHooksEnabled(toml) {
  if (/^\s*hooks\s*=\s*true/m.test(toml)) return toml;
  if (/^codex_hooks\s*=\s*true/m.test(toml)) {
    return toml.replace(/^codex_hooks\s*=\s*true/m, "hooks = true");
  }
  const m = toml.match(/^\[features\][ \t]*\n/m);
  if (m?.index !== undefined) {
    const at = m.index + m[0].length;
    return toml.slice(0, at) + "hooks = true\n" + toml.slice(at);
  }
  const tail = toml.endsWith("\n") ? "" : "\n";
  return toml + tail + "\n[features]\nhooks = true\n";
}

/**
 * Apply CodexInfo config to a TOML string.
 * Returns { toml, hooksMigrated, changed } on success, or { error } on conflict.
 */
function applyCodexinfoConfig(toml, nodeExec, hookPath, approvalWait, force = false) {
  const notifyKind = detectNotifyKind(toml);
  if (notifyKind === "unknown" && !force) {
    const existingLine = toml.match(/^notify\s*=\s*\[.*\]/m)?.[0] ?? "(unknown notify)";
    return { error: `A non-CodexInfo notify command is already configured:\n  ${existingLine}\nUse --force to replace.` };
  }

  let result = toml;
  let hooksMigrated = false;
  const command = `${nodeExec} ${hookPath}`;

  // Step 1: Remove existing CodexInfo marker block (migration from Phase 11/12)
  if (result.includes(MARKER_BEGIN)) {
    const hadStop = result.includes("[[hooks.Stop]]");
    const beginIdx = result.indexOf(MARKER_BEGIN);
    const endIdx = result.indexOf(MARKER_END);
    if (endIdx >= 0) {
      result = result.slice(0, beginIdx) + result.slice(endIdx + MARKER_END.length);
    }
    if (hadStop) hooksMigrated = true;
  }

  // Step 2: Remove existing notify line (codexinfo or ext-agent-beta2 or unknown+force)
  result = result.replace(/^# codexinfo notify[ \t]*\n/m, "");
  result = result.replace(/^notify\s*=\s*\[.*\][ \t]*\n?/m, "");

  // Step 3: Insert new notify before first section header
  result = insertNotifyAtTopLevel(result, buildNotifyLine(nodeExec, hookPath));

  // Step 4: Handle PermissionRequest block — ensureHooksEnabled BEFORE appending block
  if (approvalWait) {
    result = ensureHooksEnabled(result);
    result = result + (result.endsWith("\n") ? "" : "\n") + "\n" + buildPermissionRequestBlock(command);
  } else {
    // Remove hooks = true if no structured [[hooks.*]] sections remain
    if (!/^\[\[hooks\./m.test(result)) {
      result = result.replace(/^\s*hooks\s*=\s*true[ \t]*\n?/m, "");
      result = result.replace(/^\[features\][ \t]*\n(?=\[|\n|$)/m, "");
    }
  }

  // Step 5: Normalize excess blank lines
  result = result.replace(/\n{3,}/g, "\n\n");
  if (!result.endsWith("\n")) result += "\n";

  return { toml: result, hooksMigrated, changed: result !== toml };
}

// ─── rate-limit probe (for doctor) ───────────────────────────────────────────

function findCodexBin() {
  const fallbacks = [
    `${homedir()}/.npm-global/bin/codex`,
    `${homedir()}/.local/bin/codex`,
    `/usr/local/bin/codex`,
  ];
  for (const p of fallbacks) {
    try { if (existsSync(p)) return p; } catch { /* skip */ }
  }
  return "codex";
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
              });
            }
          }
        }

        done(buckets.length > 0 ? { buckets } : null);
      } catch {
        done(null);
      } finally {
        try { proc.stdin?.end(); proc.kill(); } catch { /* ignore */ }
        clearTimeout(timer);
      }
    })();
  });
}

// ─── status model ─────────────────────────────────────────────────────────────

function isTrustedInCodex(_hookPath, configPath = CODEX_CONFIG_PATH) {
  try {
    if (!existsSync(configPath)) return false;
    const raw = readFileSync(configPath, "utf8");
    // Codex v0.130.0 persists hook trust inside config.toml under
    // [hooks.state."<cfg_path>:permission_request:<outer>:<inner>"]
    // with enabled = true and trusted_hash = "sha256:<hex>".
    const sectionRe = /\[hooks\.state\."[^"]*:permission_request:\d+:\d+"\]([\s\S]*?)(?=\n\[|$)/g;
    let m;
    while ((m = sectionRe.exec(raw)) !== null) {
      const block = m[1];
      if (
        /^\s*enabled\s*=\s*true\s*$/m.test(block) &&
        /^\s*trusted_hash\s*=\s*"sha256:[0-9a-f]+"\s*$/m.test(block)
      ) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

function buildSetupStatusReport({ channelDesc, notifyInstalled, deliveriesConfigured, permReqInstalled, hookPath }) {
  let completion;
  if (!notifyInstalled) {
    completion = { status: "error", detail: "notify not installed — run setup" };
  } else if (!deliveriesConfigured) {
    completion = { status: "pending_action", detail: "configure deliveries in OpenClaw plugin config" };
  } else {
    completion = { status: "ready" };
  }

  const rateLimit = completion.status === "ready"
    ? { status: "ready" }
    : { status: completion.status, detail: completion.detail };

  let approvalWait;
  if (!permReqInstalled) {
    approvalWait = { status: "disabled" };
  } else if (isTrustedInCodex(hookPath)) {
    approvalWait = { status: "ready" };
  } else {
    approvalWait = { status: "pending_action" };
  }

  const isAllReady =
    completion.status === "ready" &&
    (approvalWait.status === "ready" || approvalWait.status === "disabled");

  return { channelDesc, isAllReady, completion, rateLimit, approvalWait };
}

function featureLine(label, fs) {
  switch (fs.status) {
    case "ready":          return `${label}: ✅ ready`;
    case "pending_action": return `${label}: ⚠️ action required`;
    case "disabled":       return `${label}: disabled`;
    case "error":          return `${label}: ❌ error${fs.detail ? ` — ${fs.detail}` : ""}`;
    default:               return `${label}: ❓ ${fs.status}`;
  }
}

function renderStatusNotification(report, context = "setup") {
  const hasPending =
    report.completion.status === "pending_action" ||
    report.rateLimit.status === "pending_action" ||
    report.approvalWait.status === "pending_action";

  const title = hasPending
    ? context === "setup" ? "🦞 CodexInfo setup" : "🦞 CodexInfo status"
    : "🦞 CodexInfo ready";

  const lines = [
    title,
    "",
    `Channel: ${report.channelDesc}`,
    featureLine("Complete", report.completion),
    featureLine("Rate limit", report.rateLimit),
    featureLine("Approval wait", report.approvalWait),
  ];

  if (report.approvalWait.status === "pending_action") {
    lines.push(
      "",
      "To enable approval-wait notifications:",
      "1. Open Codex",
      "2. Run /hooks",
      "3. Select \"PermissionRequest\"",
      "4. Press t to trust the CodexInfo hook",
      "5. Confirm \"Trust Trusted\" is shown",
      "",
      "Then run:",
      "  codexinfo doctor --notify",
    );
  }

  return lines.join("\n");
}

// ─── delivery helpers ─────────────────────────────────────────────────────────

function readCliHookConfig() {
  try {
    if (!existsSync(HOOK_CONFIG_PATH)) return null;
    const raw = JSON.parse(readFileSync(HOOK_CONFIG_PATH, "utf8"));
    if (typeof raw.gatewayUrl === "string" && typeof raw.token === "string") {
      return { gatewayUrl: raw.gatewayUrl, token: raw.token };
    }
    return null;
  } catch {
    return null;
  }
}

function cliDeliverText({ gatewayUrl, token, text }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };

    const url = new URL(`${gatewayUrl}/plugins/codexinfo/deliver-text`);
    const body = JSON.stringify({ text });
    const opts = {
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "Authorization": `Bearer ${token}`,
      },
    };

    const timer = setTimeout(() => done({ ok: false, error: "timeout" }), 8000);
    const reqFn = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = reqFn(opts, (res) => {
      clearTimeout(timer);
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        if (res.statusCode === 200) {
          done({ ok: true, statusCode: res.statusCode });
        } else {
          done({ ok: false, statusCode: res.statusCode, error: data.slice(0, 200) });
        }
      });
    });
    req.on("error", (err) => { clearTimeout(timer); done({ ok: false, error: err.message }); });
    req.write(body);
    req.end();
  });
}

// ─── setup ───────────────────────────────────────────────────────────────────

async function runSetup() {
  process.stdout.write(`\nCodexInfo v0.1 setup\n${"─".repeat(40)}\n\n`);

  if (flags.dryRun) process.stdout.write("Dry-run mode — no files will be written.\n\n");

  // Check codex
  const codexVersion = await detectCodexVersion();
  if (!codexVersion) {
    process.stderr.write("❌ Codex CLI not found. Install Codex v0.130.0+ first.\n");
    process.exit(1);
  }
  if (!meetsMinVersion(codexVersion, CODEX_MIN)) {
    process.stderr.write(`❌ Codex v${codexVersion} is too old. Minimum: v${CODEX_MIN}.\n`);
    process.exit(1);
  }
  process.stdout.write(`✅ Codex CLI: v${codexVersion}\n`);

  // Check hook runner
  if (!existsSync(HOOK_RUNNER)) {
    process.stderr.write(`❌ Hook runner not found at: ${HOOK_RUNNER}\n`);
    process.exit(1);
  }
  process.stdout.write(`✅ Hook runner: ${HOOK_RUNNER}\n`);

  // Routing
  const channels = flags.channels;
  let routing;
  if (channels.length === 0 || channels.includes("all")) {
    if (channels.some((c) => c !== "all")) {
      process.stderr.write("❌ Cannot mix --channel all with specific channels.\n");
      process.exit(1);
    }
    routing = { mode: "broadcast", targetChannels: [] };
  } else {
    routing = { mode: "channels", targetChannels: channels };
  }
  process.stdout.write(`✅ Channel routing: ${routing.mode === "broadcast" ? "all (broadcast)" : channels.join(", ")}\n`);

  const approvalWait = !flags.noApprovalWait;
  const currentToml = (() => { try { return readFileSync(CODEX_CONFIG_PATH, "utf8"); } catch { return ""; } })();
  const applyResult = applyCodexinfoConfig(currentToml, process.execPath, HOOK_RUNNER, approvalWait, flags.force);

  if ("error" in applyResult) {
    process.stderr.write(`❌ ${applyResult.error}\n`);
    process.exit(1);
  }

  const { toml: newToml, hooksMigrated, changed: tomlChanged } = applyResult;

  if (hooksMigrated) {
    process.stdout.write("ℹ️  Migrating stale Phase 11/12 [[hooks.Stop]] → notify path.\n");
  }

  const token = randomBytes(24).toString("hex");
  const gatewayUrl = flags.gatewayUrl;

  process.stdout.write("\nPlanned changes:\n");
  if (tomlChanged) {
    const mode = approvalWait ? "notify + PermissionRequest hook" : "notify";
    process.stdout.write(`  • Write ~/.codex/config.toml (${mode})\n`);
  } else {
    process.stdout.write(`  • ~/.codex/config.toml already configured (no change)\n`);
  }
  process.stdout.write(`  • Write ${HOOK_CONFIG_PATH}\n`);
  process.stdout.write(`  • Write ${PLUGIN_CONFIG_PATH}\n`);
  process.stdout.write(`  • Write ${MANIFEST_PATH}\n`);

  if (!flags.yes && !flags.dryRun) {
    const ans = await ask("\nProceed? [y/N] ");
    if (ans.toLowerCase() !== "y") { process.stdout.write("Cancelled.\n"); return; }
  }

  if (flags.dryRun) { process.stdout.write("\n✅ Dry-run complete. No files written.\n"); return; }

  await mkdir(OPENCLAW_DIR, { recursive: true });
  await mkdir(dirname(CODEX_CONFIG_PATH), { recursive: true });

  if (tomlChanged) {
    const backup = `${CODEX_CONFIG_PATH}.codexinfo-backup-${Date.now()}`;
    if (existsSync(CODEX_CONFIG_PATH)) {
      await writeFile(backup, currentToml, "utf8");
      process.stdout.write(`  • Backup: ${backup}\n`);
    }
    await writeFile(CODEX_CONFIG_PATH, newToml, "utf8");
    process.stdout.write(`  • Wrote ~/.codex/config.toml\n`);
  }

  await writeFile(HOOK_CONFIG_PATH, JSON.stringify({ gatewayUrl, token }, null, 2), "utf8");

  const pluginConfig = {
    token,
    deliveries: [],
    routing,
    journal: { enabled: !flags.noJournal, retentionDays: 7 },
    diagnostics: { enabled: false, retentionDays: 7, rawCapture: false },
    display: { weeklyResetFormat: "date" },
  };
  await writeFile(PLUGIN_CONFIG_PATH, JSON.stringify(pluginConfig, null, 2), "utf8");

  const addedKeys = ["notify"];
  if (approvalWait) addedKeys.push("hooks.PermissionRequest");
  const manifest = {
    version: "0.1.8",
    installedAt: new Date().toISOString(),
    codexConfigPath: CODEX_CONFIG_PATH,
    addedKeys,
    hookConfigPath: HOOK_CONFIG_PATH,
    pluginConfigPath: PLUGIN_CONFIG_PATH,
  };
  await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2), "utf8");

  const channelDesc = routing.mode === "broadcast" ? "all" : channels.join(", ");

  // Extract hook path from newly written TOML for status report
  const hookMatch = newToml.match(/^notify\s*=\s*\[.*?,\s*"([^"]+codexinfo-hook\.js[^"]*)"\s*\]/m);
  const hookPath = hookMatch?.[1] ?? HOOK_RUNNER;

  // Build status report — deliveries not yet configured (just installed)
  const report = buildSetupStatusReport({
    channelDesc,
    notifyInstalled: true,
    deliveriesConfigured: false,
    permReqInstalled: approvalWait,
    hookPath,
  });

  const statusText = renderStatusNotification(report, "setup");
  process.stdout.write(`\n${statusText}\n`);

  process.stdout.write(`
Next steps:
  1. Install the OpenClaw plugin (enables channel delivery):
     openclaw plugins install npm:codexinfo

  2. Set your delivery targets in OpenClaw:
     openclaw gateway config set 'plugins.entries.codexinfo.token' '<paste token from ~/.openclaw/codexinfo/hook-config.json>'
     openclaw gateway config set 'plugins.entries.codexinfo.deliveries' '[{"channel":"telegram","to":"YOUR_CHAT_ID"}]'

  3. Restart OpenClaw gateway:
     openclaw gateway restart

  4. Verify:
     npx codexinfo doctor --notify

Note: journal is ${flags.noJournal ? "DISABLED" : "enabled (use --no-journal to disable)"}.
`);

  // Attempt to send status notification to channel (best-effort)
  const hookCfg = readCliHookConfig();
  if (hookCfg) {
    process.stdout.write("⏳ Sending setup status notification...\n");
    const result = await cliDeliverText({ gatewayUrl: hookCfg.gatewayUrl, token: hookCfg.token, text: statusText });
    if (result.ok) {
      process.stdout.write("✅ Setup status notification sent.\n");
    } else {
      process.stdout.write("ℹ️  Could not send notification yet — configure OpenClaw plugin first.\n");
    }
  }
}

// ─── doctor ──────────────────────────────────────────────────────────────────

async function runDoctor() {
  process.stdout.write(`\nCodexInfo doctor\n${"─".repeat(40)}\n\n`);
  let allGreen = true;

  const check = (label, ok, detail) => {
    const icon = ok ? "✅" : "❌";
    const suffix = detail ? `  (${detail})` : "";
    process.stdout.write(`  ${icon} ${label}${suffix}\n`);
    if (!ok) allGreen = false;
    return ok;
  };
  const warn = (msg) => { process.stdout.write(`  ⚠️  ${msg}\n`); allGreen = false; };
  const info = (msg) => process.stdout.write(`  ℹ️  ${msg}\n`);

  // ── Codex CLI ──────────────────────────────────────────────────────────────
  process.stdout.write("Codex CLI\n");
  const ver = await detectCodexVersion();
  if (!check("codex binary found", ver !== null, ver ?? "not in PATH")) {
    /* allGreen already false */
  }
  if (ver) {
    check(`codex >= v${CODEX_MIN}`, meetsMinVersion(ver, CODEX_MIN), `v${ver}`);
  }

  // ── Codex notify path ──────────────────────────────────────────────────────
  process.stdout.write("\nCodex notify path\n");
  const tomlExists = existsSync(CODEX_CONFIG_PATH);
  if (!check("~/.codex/config.toml exists", tomlExists)) {
    /* allGreen false */
  }

  let notifyInstalled = false;
  let permReqInstalled = false;
  let hookPath = "";

  if (tomlExists) {
    const toml = readFileSync(CODEX_CONFIG_PATH, "utf8");
    const notifyKind = detectNotifyKind(toml);

    if (notifyKind === "codexinfo") {
      check("notify path: codexinfo-hook.js installed", true);
      notifyInstalled = true;
    } else if (notifyKind === "none") {
      check("notify path: codexinfo-hook.js installed", false, "absent — run: npx codexinfo setup");
    } else if (notifyKind === "ext-agent-beta2") {
      warn("notify path: ext-agent β2 (hook_helper.py) — stale, causes duplicate notifications");
      warn("  Fix: run `npx codexinfo setup` to replace with CodexInfo notify");
    } else {
      warn("notify path: unknown command already configured — conflict");
      warn("  Fix: run `npx codexinfo setup --force` to replace, or remove manually");
    }

    // Stale Stop hook detection
    const hasMarkerBlock = toml.includes(MARKER_BEGIN);
    const hasStaleStop = hasMarkerBlock && toml.includes("[[hooks.Stop]]");
    if (hasStaleStop) {
      warn("[[hooks.Stop]]: stale (Phase 11/12) — causes 'hooks need review' warning in Codex");
      warn("  Fix: run `npx codexinfo setup` to migrate away");
    } else {
      check("[[hooks.Stop]]: absent (correct for default mode)", true);
    }

    // PermissionRequest status
    const hasPermReq = hasMarkerBlock && toml.includes("[[hooks.PermissionRequest]]");
    permReqInstalled = hasPermReq;
    if (hasPermReq) {
      info("[[hooks.PermissionRequest]]: installed (approval-wait mode)");
      if (isTrustedInCodex("", CODEX_CONFIG_PATH)) {
        info("  Codex /hooks Trust: ✅ trusted");
      } else {
        info("  Codex /hooks Trust review required — open Codex and run: /hooks");
      }
    } else {
      info("[[hooks.PermissionRequest]]: absent (default mode — no Trust review needed)");
    }

    const hookMatch = toml.match(/^notify\s*=\s*\[.*?,\s*"([^"]+codexinfo-hook\.js[^"]*)"\s*\]/m);
    hookPath = hookMatch?.[1] ?? "";
  }

  // ── CodexInfo config ───────────────────────────────────────────────────────
  process.stdout.write("\nCodexInfo config\n");
  check("hook-config.json exists", existsSync(HOOK_CONFIG_PATH), HOOK_CONFIG_PATH);
  const pluginConfigExists = existsSync(PLUGIN_CONFIG_PATH);
  let deliveriesConfigured = false;
  let channelDesc = "unknown";
  if (check("plugin config exists", pluginConfigExists, PLUGIN_CONFIG_PATH)) {
    try {
      const cfg = JSON.parse(readFileSync(PLUGIN_CONFIG_PATH, "utf8"));
      check("token configured", typeof cfg.token === "string" && cfg.token.length >= 16);
      const d = cfg.deliveries;
      deliveriesConfigured = Array.isArray(d) && d.length > 0;
      // Fallback: check gateway state file if OPENCLAW_STATE_DIR is set
      if (!deliveriesConfigured) {
        const stateDir = process.env.OPENCLAW_STATE_DIR;
        if (stateDir) {
          try {
            const ocJson = JSON.parse(readFileSync(join(stateDir, "openclaw.json"), "utf8"));
            const gwDel = ocJson?.plugins?.entries?.codexinfo?.config?.deliveries;
            deliveriesConfigured = Array.isArray(gwDel) && gwDel.length > 0;
          } catch { /* ignore */ }
        }
      }
      check(
        "deliveries configured",
        deliveriesConfigured,
        Array.isArray(d) ? `${d.length} entry/entries` : "none",
      );
      info(`journal: ${cfg.journal?.enabled !== false ? "enabled" : "disabled"}`);
      const routing = cfg.routing;
      channelDesc = routing?.mode === "broadcast"
        ? "all"
        : ((routing?.targetChannels ?? []).join(", ") || "unknown");
    } catch {
      check("plugin config is valid JSON", false);
    }
  }

  // ── Claude Code notification residue ──────────────────────────────────────
  process.stdout.write("\nClaude Code notification residue\n");
  if (existsSync(CLAUDE_SETTINGS_PATH)) {
    const claudeContent = readFileSync(CLAUDE_SETTINGS_PATH, "utf8");
    if (claudeContent.includes("hook_helper.py")) {
      warn("ext-agent β2 Stop hook found in ~/.claude/settings.json");
      info(`  Location: ${CLAUDE_SETTINGS_PATH}`);
      info("  Effect: Claude Code completions also send notifications (separate from CodexInfo)");
      info("  To stop Claude Code notifications: remove the Stop hook entry from that file");
    } else {
      check("~/.claude/settings.json: no ext-agent residue", true);
    }
  } else {
    info("~/.claude/settings.json not found (Claude Code not configured here)");
  }

  // ── Rate-limit probe ───────────────────────────────────────────────────────
  process.stdout.write("\nRate-limit probe\n");
  if (ver) {
    process.stdout.write("  ⏳ probing codex app-server (up to 6s)...\n");
    const usage = await probeRateLimits();
    if (check("rate-limit probe reachable", usage !== null)) {
      if (usage?.buckets) {
        for (const b of usage.buckets) {
          info(`${b.windowLabel}: ${100 - b.usedPercent}% left`);
        }
      }
    } else {
      warn("Rate-limit probe failed — notifications will lack rate-limit bars");
    }
  } else {
    warn("Skipping rate-limit probe — codex not found");
  }

  process.stdout.write("\n");
  if (allGreen) process.stdout.write("✅ All checks passed. CodexInfo is ready.\n\n");
  else { process.stdout.write("❌ Some checks failed. Run: npx codexinfo setup\n\n"); process.exitCode = 1; }

  if (flags.notify) {
    const report = buildSetupStatusReport({
      channelDesc,
      notifyInstalled,
      deliveriesConfigured,
      permReqInstalled,
      hookPath,
    });
    const statusText = renderStatusNotification(report, "doctor");
    const hookCfg = readCliHookConfig();
    if (!hookCfg) {
      process.stderr.write("⚠️  --notify: hook-config.json not found — run setup first.\n");
      return;
    }
    process.stdout.write("⏳ Sending diagnostic notification...\n");
    const result = await cliDeliverText({ gatewayUrl: hookCfg.gatewayUrl, token: hookCfg.token, text: statusText });
    if (result.ok) {
      process.stdout.write("✅ Diagnostic notification sent.\n");
    } else {
      process.stderr.write(`❌ Delivery failed: ${result.error ?? "unknown error"}\n`);
      process.exitCode = 1;
    }
  }
}

// ─── status ──────────────────────────────────────────────────────────────────

async function runStatus() {
  process.stdout.write(`\nCodexInfo status\n${"─".repeat(40)}\n\n`);
  if (!existsSync(PLUGIN_CONFIG_PATH)) {
    process.stdout.write("Not configured. Run: npx codexinfo setup\n\n");
    return;
  }
  let cfg;
  try { cfg = JSON.parse(readFileSync(PLUGIN_CONFIG_PATH, "utf8")); }
  catch { process.stdout.write("❌ Plugin config is not valid JSON.\n\n"); return; }

  const r = cfg.routing;
  const mode = r?.mode === "broadcast" ? "broadcast (all)" : `channels: ${(r?.targetChannels ?? []).join(", ") || "(none)"}`;
  process.stdout.write(`Channel routing:  ${mode}\n`);

  const deliveries = cfg.deliveries ?? [];
  process.stdout.write(`Deliveries:       ${deliveries.length} entry/entries\n`);
  for (const d of deliveries) process.stdout.write(`  • ${d.channel} → (configured)\n`);
  process.stdout.write(`Journal:          ${cfg.journal?.enabled !== false ? "enabled" : "disabled"}\n`);
  process.stdout.write(`Diagnostics:      ${cfg.diagnostics?.enabled === true ? "enabled" : "disabled"}\n`);
  process.stdout.write(`Weekly format:    ${cfg.display?.weeklyResetFormat ?? "date"}\n`);

  if (existsSync(MANIFEST_PATH)) {
    try {
      const m = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
      process.stdout.write(`\nInstalled at:     ${m.installedAt ?? "unknown"}\n`);
      process.stdout.write(`Version:          ${m.version ?? "unknown"}\n`);
    } catch { /* skip */ }
  }

  // ── Notification readiness ─────────────────────────────────────────────────
  process.stdout.write(`\n${"─".repeat(40)}\nNotification readiness\n${"─".repeat(40)}\n`);

  const tomlExists = existsSync(CODEX_CONFIG_PATH);
  let notifyInstalled = false;
  let permReqInstalled = false;
  let hookPath = "";

  if (tomlExists) {
    const toml = readFileSync(CODEX_CONFIG_PATH, "utf8");
    notifyInstalled = detectNotifyKind(toml) === "codexinfo";
    const hasMarker = toml.includes(MARKER_BEGIN);
    permReqInstalled = hasMarker && toml.includes("[[hooks.PermissionRequest]]");
    const hookMatch = toml.match(/^notify\s*=\s*\[.*?,\s*"([^"]+codexinfo-hook\.js[^"]*)"\s*\]/m);
    hookPath = hookMatch?.[1] ?? "";
  }

  // Gateway state file is the authoritative source for deliveries.
  let deliveriesOk = deliveries.length > 0;
  if (!deliveriesOk) {
    const stateDir = process.env.OPENCLAW_STATE_DIR;
    if (stateDir) {
      try {
        const ocJson = JSON.parse(readFileSync(join(stateDir, "openclaw.json"), "utf8"));
        const gwDel = ocJson?.plugins?.entries?.codexinfo?.config?.deliveries;
        deliveriesOk = Array.isArray(gwDel) && gwDel.length > 0;
      } catch { /* ignore */ }
    }
  }

  const channelDesc = r?.mode === "broadcast" ? "all" : (r?.targetChannels ?? []).join(", ") || "(none)";
  const report = buildSetupStatusReport({
    channelDesc,
    notifyInstalled,
    deliveriesConfigured: deliveriesOk,
    permReqInstalled,
    hookPath,
  });

  const statusText = renderStatusNotification(report, "status");
  process.stdout.write(`${statusText}\n\n`);

  if (flags.notify) {
    const hookCfg = readCliHookConfig();
    if (!hookCfg) {
      process.stderr.write("⚠️  hook-config.json not found — run setup first.\n");
      return;
    }
    process.stdout.write("⏳ Sending status notification...\n");
    const result = await cliDeliverText({ gatewayUrl: hookCfg.gatewayUrl, token: hookCfg.token, text: statusText });
    if (result.ok) {
      process.stdout.write("✅ Status notification sent.\n");
    } else {
      process.stderr.write(`❌ Delivery failed: ${result.error ?? "unknown error"}\n`);
      process.stderr.write("   Check: npx codexinfo doctor\n");
      process.exitCode = 1;
    }
  }
}

// ─── uninstall ───────────────────────────────────────────────────────────────

function removeCodexinfoHooks(toml) {
  let result = toml;

  // Remove marker block (structured hooks)
  if (result.includes(MARKER_BEGIN)) {
    const bi = result.indexOf(MARKER_BEGIN);
    const ei = result.indexOf(MARKER_END);
    if (ei >= 0) result = result.slice(0, bi) + result.slice(ei + MARKER_END.length);
  }

  // Remove CodexInfo notify line
  result = result.replace(/^# codexinfo notify[ \t]*\n/m, "");
  result = result.replace(/^notify\s*=\s*\[.*codexinfo-hook\.js.*\][ \t]*\n?/m, "");

  // Remove deprecated codex_hooks = true
  result = result.replace(/^codex_hooks\s*=\s*true[ \t]*\n?/m, "");

  // Remove hooks = true only when no [[hooks.*]] sections remain
  if (!/^\[\[hooks\./m.test(result)) {
    result = result.replace(/^\s*hooks\s*=\s*true[ \t]*\n?/m, "");
  }

  // Remove empty [features] section
  result = result.replace(/^\[features\][ \t]*\n(?=\[|\n|$)/m, "");

  return result.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

async function runUninstall() {
  process.stdout.write(`\nCodexInfo uninstall\n${"─".repeat(40)}\n\n`);
  if (flags.dryRun) process.stdout.write("Dry-run — no changes will be made.\n\n");

  if (!existsSync(MANIFEST_PATH)) {
    process.stdout.write("CodexInfo is not installed (no manifest found).\n\n");
    return;
  }

  let manifest;
  try { manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")); }
  catch { process.stderr.write("❌ Cannot read manifest. Aborting.\n"); process.exit(1); }

  const addedKeys = manifest.addedKeys ?? [];
  const codexConfigPath = manifest.codexConfigPath ?? CODEX_CONFIG_PATH;
  const hasNotify = addedKeys.includes("notify");
  const hasHooks = addedKeys.some((k) => k.startsWith("hooks.") || k === "hooks" || k === "codex_hooks");
  const willTouchToml = (hasNotify || hasHooks) && existsSync(codexConfigPath);

  process.stdout.write("Will remove:\n");
  if (willTouchToml) process.stdout.write(`  • codexinfo notify + hook entries from ${codexConfigPath}\n`);
  process.stdout.write(`  • ${HOOK_CONFIG_PATH}\n`);
  process.stdout.write(`  • ${PLUGIN_CONFIG_PATH}\n`);
  process.stdout.write(`  • ${MANIFEST_PATH}\n`);
  process.stdout.write("Will NOT touch:\n  • Other OpenClaw config\n  • Codex auth\n\n");

  if (!flags.yes && !flags.dryRun) {
    const ans = await ask("Proceed? [y/N] ");
    if (ans.toLowerCase() !== "y") { process.stdout.write("Cancelled.\n"); return; }
  }

  if (flags.dryRun) { process.stdout.write("✅ Dry-run complete.\n\n"); return; }

  if (willTouchToml) {
    try {
      const toml = await readFile(codexConfigPath, "utf8");
      const backup = `${codexConfigPath}.codexinfo-uninstall-${Date.now()}`;
      await writeFile(backup, toml, "utf8");
      const updated = removeCodexinfoHooks(toml);
      await writeFile(codexConfigPath, updated, "utf8");
      process.stdout.write(`  • Removed codexinfo config from ${codexConfigPath}\n`);
      process.stdout.write(`  • Backup: ${backup}\n`);
    } catch (err) {
      process.stderr.write(`  ⚠️  Could not update ${codexConfigPath}: ${err}\n`);
    }
  }

  for (const p of [HOOK_CONFIG_PATH, PLUGIN_CONFIG_PATH, MANIFEST_PATH]) {
    if (existsSync(p)) { await rm(p, { force: true }); process.stdout.write(`  • Removed ${p}\n`); }
  }

  process.stdout.write("\n✅ CodexInfo uninstalled.\n");
  process.stdout.write("  To remove the npm package: npm uninstall -g codexinfo\n\n");
}

// ─── main ────────────────────────────────────────────────────────────────────

if (argv.includes("--help") || argv.includes("-h") || subcommand === "help") {
  process.stdout.write(`
codexinfo v0.1 — Codex CLI notifications via OpenClaw

Usage:
  npx codexinfo setup [options]
  npx codexinfo doctor [--notify]
  npx codexinfo status [--notify]
  npx codexinfo uninstall [--yes] [--dry-run]

Setup options:
  --channel <name>     Target channel. Repeat for multiple. Default: all.
  --no-journal         Disable notification journal.
  --gateway-url <url>  OpenClaw gateway URL. Default: http://localhost:3000.
  --no-approval-wait   Skip PermissionRequest hook (approval-wait is ON by default).
  --force              Replace unknown notify command without error.
  --yes                Skip confirmation prompts.
  --dry-run            Preview changes without writing files.

Doctor / Status options:
  --notify             Also send a status notification to the configured channel.

Default mode installs notify + PermissionRequest hook (approval-wait ON).
Use --no-approval-wait to skip the PermissionRequest hook (no /hooks Trust review needed).

After setup, also available as: openclaw codexinfo <subcommand>
`);
} else if (subcommand === "setup") {
  await runSetup();
} else if (subcommand === "doctor") {
  await runDoctor();
} else if (subcommand === "status") {
  await runStatus();
} else if (subcommand === "uninstall") {
  await runUninstall();
} else {
  process.stderr.write(`Unknown command: ${subcommand}\nRun: npx codexinfo --help\n`);
  process.exitCode = 1;
}
