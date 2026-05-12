import { execFile as execFileCb } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import type { Command } from "commander";
import type { CliContext } from "./index.js";
import { buildSetupStatusReport } from "../setup-status.js";
import { renderStatusNotification } from "../render-status.js";
import { cliDeliverText, readCliHookConfig } from "./deliver-cli.js";

const execFile = promisify(execFileCb);

const CONFIG_DIR = join(homedir(), ".openclaw", "codexinfo");
const HOOK_CONFIG_PATH = join(CONFIG_DIR, "hook-config.json");
const PLUGIN_CONFIG_PATH = join(CONFIG_DIR, "config.json");
const MANIFEST_PATH = join(CONFIG_DIR, "manifest.json");
const CODEX_CONFIG_PATH = join(homedir(), ".codex", "config.toml");

const CODEX_MIN_VERSION = "0.130.0";

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function detectCodexVersion(): Promise<string | null> {
  try {
    const { stdout } = await execFile("codex", ["--version"], { timeout: 5000, shell: true });
    const match = stdout.match(/(\d+\.\d+\.\d+)/);
    return match ? (match[1] ?? null) : null;
  } catch {
    return null;
  }
}

export function meetsMinVersion(version: string, minVersion: string): boolean {
  const parse = (v: string) => v.split(".").map(Number);
  const [ma, mi, pa] = parse(version);
  const [mma, mmi, mpa] = parse(minVersion);
  if (ma !== mma) return (ma ?? 0) > (mma ?? 0);
  if (mi !== mmi) return (mi ?? 0) > (mmi ?? 0);
  return (pa ?? 0) >= (mpa ?? 0);
}

function resolveHookRunnerPath(): string {
  const thisFile = fileURLToPath(import.meta.url);
  const pkgRoot = dirname(dirname(dirname(thisFile)));
  return join(pkgRoot, "bin", "codexinfo-hook.js");
}

function generateToken(): string {
  return randomBytes(24).toString("hex");
}

interface SetupOptions {
  channels: string[];
  noJournal: boolean;
  dryRun: boolean;
  yes: boolean;
  gatewayUrl: string;
  approvalWait: boolean;
  noApprovalWait: boolean;
  force: boolean;
}

export function parseChannels(raw: string[]): { mode: "broadcast" | "channels"; targetChannels: string[] } {
  if (raw.length === 0 || raw.includes("all")) {
    if (raw.some((c) => c !== "all")) {
      throw new Error("Cannot mix --channel all with specific channel names.");
    }
    return { mode: "broadcast", targetChannels: [] };
  }
  return { mode: "channels", targetChannels: raw };
}

function quoteForToml(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

async function readCodexConfig(): Promise<string> {
  try {
    return await readFile(CODEX_CONFIG_PATH, "utf8");
  } catch {
    return "";
  }
}

export const CODEXINFO_MARKER_BEGIN = "# codexinfo-begin";
export const CODEXINFO_MARKER_END = "# codexinfo-end";

// ─── Notify line management ──────────────────────────────────────────────────

export type NotifyKind = "none" | "codexinfo" | "ext-agent-beta2" | "unknown";

export function detectNotifyKind(toml: string): NotifyKind {
  if (!/^notify\s*=/m.test(toml)) return "none";
  if (/^notify\s*=\s*\[.*codexinfo-hook\.js.*\]/m.test(toml)) return "codexinfo";
  if (/^notify\s*=\s*\[.*hook_helper\.py.*\]/m.test(toml)) return "ext-agent-beta2";
  return "unknown";
}

function buildNotifyLine(nodeExec: string, hookPath: string): string {
  const nodeQ = quoteForToml(nodeExec);
  const hookQ = quoteForToml(hookPath);
  return `# codexinfo notify\nnotify = [${nodeQ}, ${hookQ}]\n`;
}

function insertNotifyAtTopLevel(toml: string, notifyLine: string): string {
  // Insert before the first [section] or [[array]] header with blank-line separation
  const sectionMatch = toml.match(/^(\[|\[\[)/m);
  if (sectionMatch?.index !== undefined) {
    const before = toml.slice(0, sectionMatch.index).replace(/\n+$/, "");
    const after = toml.slice(sectionMatch.index);
    return (before ? before + "\n\n" : "") + notifyLine + "\n\n" + after;
  }
  const trimmed = toml.replace(/\n*$/, "");
  return (trimmed ? trimmed + "\n\n" : "") + notifyLine + "\n";
}

// ─── PermissionRequest-only hook block ──────────────────────────────────────

function buildPermissionRequestBlock(command: string): string {
  const cmd = quoteForToml(command);
  return [
    CODEXINFO_MARKER_BEGIN,
    "[[hooks.PermissionRequest]]",
    "",
    "[[hooks.PermissionRequest.hooks]]",
    `type    = "command"`,
    `command = ${cmd}`,
    "timeout = 30",
    CODEXINFO_MARKER_END,
    "",
  ].join("\n");
}

// ─── [features] hooks = true management ─────────────────────────────────────

function ensureHooksEnabled(toml: string): string {
  if (/^\s*hooks\s*=\s*true/m.test(toml)) return toml;
  if (/^codex_hooks\s*=\s*true/m.test(toml)) {
    return toml.replace(/^codex_hooks\s*=\s*true/m, "hooks = true");
  }
  const featuresMatch = toml.match(/^\[features\][ \t]*\n/m);
  if (featuresMatch?.index !== undefined) {
    const at = featuresMatch.index + featuresMatch[0].length;
    return toml.slice(0, at) + "hooks = true\n" + toml.slice(at);
  }
  const tail = toml.endsWith("\n") ? "" : "\n";
  return toml + tail + "\n[features]\nhooks = true\n";
}

// ─── Main TOML application function ─────────────────────────────────────────

export type ApplyResult =
  | { toml: string; hooksMigrated: boolean; changed: boolean }
  | { error: string };

/**
 * Apply CodexInfo configuration to a Codex config.toml string.
 *
 * Default mode (approvalWait=false):
 *   - Installs `notify = [node, hook.js]`  (no Codex hook Trust review needed)
 *   - Removes any stale [[hooks.Stop]] block from Phase 11/12
 *   - Does NOT install [[hooks.PermissionRequest]]
 *
 * Approval-wait mode (approvalWait=true):
 *   - Same notify install
 *   - Also installs [[hooks.PermissionRequest]] (requires Codex /hooks Trust)
 *
 * Force mode (force=true):
 *   - Replaces unknown (non-CodexInfo) notify without error
 */
export function applyCodexinfoConfig(
  toml: string,
  nodeExec: string,
  hookPath: string,
  approvalWait: boolean,
  force = false,
): ApplyResult {
  const notifyKind = detectNotifyKind(toml);

  if (notifyKind === "unknown" && !force) {
    const existingLine = toml.match(/^notify\s*=\s*\[.*\]/m)?.[0] ?? "(unknown notify)";
    return {
      error: [
        "A non-CodexInfo notify command is already configured:",
        `  ${existingLine}`,
        "",
        "CodexInfo can replace it, but that may break other tools that use notify.",
        "Run setup with --force to replace it, or remove it manually first.",
      ].join("\n"),
    };
  }

  let result = toml;
  let hooksMigrated = false;
  const command = `${nodeExec} ${hookPath}`;

  // Step 1: Remove any existing CodexInfo marker block (migration from Phase 11/12)
  if (result.includes(CODEXINFO_MARKER_BEGIN)) {
    const bi = result.indexOf(CODEXINFO_MARKER_BEGIN);
    const ei = result.indexOf(CODEXINFO_MARKER_END);
    if (ei >= 0) {
      const block = result.slice(bi, ei + CODEXINFO_MARKER_END.length);
      if (block.includes("[[hooks.Stop]]")) hooksMigrated = true;
      result = result.slice(0, bi) + result.slice(ei + CODEXINFO_MARKER_END.length);
    }
  }

  // Step 2: Remove any existing notify line (CodexInfo, ext-agent β2, or --force unknown)
  result = result.replace(/^# codexinfo notify[ \t]*\n/m, "");
  result = result.replace(/^notify\s*=\s*\[.*\][ \t]*\n?/m, "");

  // Step 3: Insert CodexInfo notify before the first section header
  result = insertNotifyAtTopLevel(result, buildNotifyLine(nodeExec, hookPath));

  // Step 4: Handle PermissionRequest block
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

export function registerSetupCommand(parent: Command, ctx: CliContext): void {
  parent
    .command("setup")
    .description("Configure CodexInfo — installs notify hook into Codex config and writes plugin config")
    .option("--install", "Also attempt to install the OpenClaw plugin if not already installed")
    .option("--channel <name>", "Target channel(s). Repeat for multiple. Omit for all.", (val: string, prev: string[]) => {
      prev.push(val);
      return prev;
    }, [] as string[])
    .option("--approval-wait", "Install PermissionRequest hook for approval-wait notifications (default: on)")
    .option("--no-approval-wait", "Skip PermissionRequest hook — completion and rate-limit only")
    .option("--force", "Replace existing non-CodexInfo notify command without error")
    .option("--no-journal", "Disable journal")
    .option("--dry-run", "Preview changes without writing")
    .option("--yes", "Skip confirmation prompts")
    .option("--gateway-url <url>", "OpenClaw gateway URL (default: auto-detected or http://localhost:3000)")
    .action(async (opts: {
      install?: boolean;
      channel: string[];
      approvalWait?: boolean;
      noApprovalWait?: boolean;
      force?: boolean;
      noJournal?: boolean;
      dryRun?: boolean;
      yes?: boolean;
      gatewayUrl?: string;
    }) => {
      const inferredPort = (ctx.cfg as Record<string, unknown> | undefined)?.["gateway"] as { port?: number } | undefined;
      const defaultGatewayUrl = `http://localhost:${inferredPort?.port ?? 3000}`;
      // approval-wait defaults ON; --no-approval-wait opts out
      const approvalWait = opts.noApprovalWait !== true;
      const options: SetupOptions = {
        channels: opts.channel,
        noJournal: opts.noJournal === true,
        dryRun: opts.dryRun === true,
        yes: opts.yes === true,
        gatewayUrl: opts.gatewayUrl ?? defaultGatewayUrl,
        approvalWait,
        noApprovalWait: opts.noApprovalWait === true,
        force: opts.force === true,
      };

      process.stdout.write(`\n📋 CodexInfo v0.1 setup\n${"─".repeat(40)}\n\n`);

      if (options.dryRun) {
        process.stdout.write("⚠️  Dry-run mode — no changes will be written.\n\n");
      }

      const codexVersion = await detectCodexVersion();
      if (!codexVersion) {
        process.stderr.write("❌ Codex CLI not found. Install Codex v0.130.0+ first.\n");
        process.exit(1);
      }
      process.stdout.write(`✅ Codex CLI: v${codexVersion}\n`);

      if (!meetsMinVersion(codexVersion, CODEX_MIN_VERSION)) {
        process.stderr.write(`❌ Codex v${codexVersion} is unsupported. Minimum: v${CODEX_MIN_VERSION}.\n`);
        process.exit(1);
      }

      let routing: ReturnType<typeof parseChannels>;
      try {
        routing = parseChannels(options.channels);
      } catch (err) {
        process.stderr.write(`❌ ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }

      const channelDesc =
        routing.mode === "broadcast"
          ? "all channels (broadcast)"
          : routing.targetChannels.join(", ");
      process.stdout.write(`✅ Channel routing: ${channelDesc}\n`);

      const hookRunnerPath = resolveHookRunnerPath();
      if (!existsSync(hookRunnerPath)) {
        process.stderr.write(`❌ Hook runner not found at: ${hookRunnerPath}\n`);
        process.stderr.write("   Reinstall with: openclaw plugins install npm:codexinfo\n");
        process.exit(1);
      }
      process.stdout.write(`✅ Hook runner: ${hookRunnerPath}\n`);

      if (options.approvalWait) {
        process.stdout.write(`✅ Mode: default (notify) + approval-wait (PermissionRequest hook)\n`);
      } else {
        process.stdout.write(`✅ Mode: default (notify only — no Codex hook Trust review needed)\n`);
      }

      const nodeExec = process.execPath;
      const currentToml = await readCodexConfig();
      const applyResult = applyCodexinfoConfig(
        currentToml,
        nodeExec,
        hookRunnerPath,
        options.approvalWait,
        options.force,
      );

      if ("error" in applyResult) {
        process.stderr.write(`❌ ${applyResult.error}\n`);
        process.exit(1);
      }

      const { toml: newToml, hooksMigrated, changed: tomlChanged } = applyResult;
      const token = generateToken();
      const gatewayUrl = options.gatewayUrl;

      process.stdout.write(`\n📝 Planned changes:\n`);

      if (hooksMigrated) {
        process.stdout.write(`  • Migrate stale Phase 11/12 [[hooks.Stop]] → remove it\n`);
      }
      if (tomlChanged) {
        process.stdout.write(`  • Write ~/.codex/config.toml (notify = [node, codexinfo-hook.js]`);
        if (options.approvalWait) process.stdout.write(` + PermissionRequest hook`);
        process.stdout.write(`)\n`);
      } else {
        process.stdout.write(`  • ~/.codex/config.toml already has codexinfo notify (no change)\n`);
      }
      process.stdout.write(`  • Write ${HOOK_CONFIG_PATH}\n`);
      process.stdout.write(`  • Write ${PLUGIN_CONFIG_PATH}\n`);
      process.stdout.write(`  • Write ${MANIFEST_PATH}\n`);

      if (!options.yes && !options.dryRun) {
        const answer = await ask("\nProceed? [y/N] ");
        if (answer.toLowerCase() !== "y") {
          process.stdout.write("Cancelled.\n");
          return;
        }
      }

      if (options.dryRun) {
        process.stdout.write("\n✅ Dry-run complete. No files written.\n");
        return;
      }

      await mkdir(CONFIG_DIR, { recursive: true });
      await mkdir(dirname(CODEX_CONFIG_PATH), { recursive: true });

      if (tomlChanged) {
        const backupPath = `${CODEX_CONFIG_PATH}.codexinfo-backup-${Date.now()}`;
        if (existsSync(CODEX_CONFIG_PATH)) {
          await writeFile(backupPath, currentToml, "utf8");
          process.stdout.write(`  • Backup: ${backupPath}\n`);
        }
        await writeFile(CODEX_CONFIG_PATH, newToml, "utf8");
        process.stdout.write(`  • Wrote ~/.codex/config.toml\n`);
      }

      const hookConfig = { gatewayUrl, token };
      await writeFile(HOOK_CONFIG_PATH, JSON.stringify(hookConfig, null, 2), "utf8");

      const pluginConfig = {
        token,
        deliveries: [],
        routing,
        journal: { enabled: !options.noJournal, retentionDays: 7 },
        diagnostics: { enabled: false, retentionDays: 7, rawCapture: false },
        display: { weeklyResetFormat: "date" },
      };
      await writeFile(PLUGIN_CONFIG_PATH, JSON.stringify(pluginConfig, null, 2), "utf8");

      const addedKeys = ["notify"];
      if (options.approvalWait) addedKeys.push("hooks.PermissionRequest");

      const manifest = {
        version: "0.1.3",
        installedAt: new Date().toISOString(),
        codexConfigPath: CODEX_CONFIG_PATH,
        addedKeys,
        hookConfigPath: HOOK_CONFIG_PATH,
        pluginConfigPath: PLUGIN_CONFIG_PATH,
      };
      await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2), "utf8");

      process.stdout.write(`
✅ CodexInfo setup complete!

Next steps:
  1. Add your delivery targets to OpenClaw plugin config:

     openclaw gateway config set 'plugins.entries.codexinfo.token' '<paste token from ~/.openclaw/codexinfo/hook-config.json>'
     openclaw gateway config set 'plugins.entries.codexinfo.deliveries' '[{"channel":"telegram","to":"YOUR_CHAT_ID"}]'

  2. Restart OpenClaw gateway:
     openclaw gateway restart

  3. Verify:
     openclaw codexinfo doctor

  4. Run any Codex command — a completion notification should arrive.
`);

      process.stdout.write(`Note: journal is ${options.noJournal ? "DISABLED" : "enabled (--no-journal to disable)"}.\n`);

      // ── Status report + guided notification ────────────────────────────────
      const reportChannelDesc = routing.mode === "broadcast" ? "all" : routing.targetChannels.join(", ");
      // Deliveries are empty until the user configures them in OpenClaw — report that state honestly.
      const report = buildSetupStatusReport({
        channelDesc: reportChannelDesc,
        notifyInstalled: true,
        deliveriesConfigured: false,
        permReqInstalled: options.approvalWait,
        hookPath: hookRunnerPath,
      });

      const statusText = renderStatusNotification(report, "setup");
      process.stdout.write(`\n${"─".repeat(40)}\n`);
      process.stdout.write(`${statusText}\n`);
      process.stdout.write(`${"─".repeat(40)}\n`);

      // Try to deliver via gateway (may not be running yet at first setup).
      const hookCfg = readCliHookConfig();
      if (hookCfg) {
        process.stdout.write(`\n⏳ Sending setup notification to channel...\n`);
        const deliverResult = await cliDeliverText({
          gatewayUrl: hookCfg.gatewayUrl,
          token: hookCfg.token,
          text: statusText,
        });
        if (deliverResult.ok) {
          process.stdout.write(`✅ Setup notification sent.\n`);
        } else {
          process.stdout.write(`⚠️  Could not send notification: ${deliverResult.error ?? "unknown error"}\n`);
          process.stdout.write(`   Gateway may not be running yet — run 'ocw runtime up' then 'codexinfo doctor --notify'.\n`);
        }
      } else {
        process.stdout.write(`\nℹ️  Gateway not configured yet — notification will be sent when you run 'codexinfo doctor --notify' after gateway setup.\n`);
      }
    });
}
