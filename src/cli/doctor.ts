import { execFile as execFileCb } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Command } from "commander";
import { probeRateLimits } from "../rate-limit.js";
import { detectNotifyKind, CODEXINFO_MARKER_BEGIN } from "./setup.js";
import type { CliContext } from "./index.js";
import { buildSetupStatusReport, isTrustedInCodex } from "../setup-status.js";
import { renderStatusNotification } from "../render-status.js";
import { cliDeliverText, readCliHookConfig } from "./deliver-cli.js";

const execFile = promisify(execFileCb);
const CONFIG_DIR = join(homedir(), ".openclaw", "codexinfo");
const CODEX_CONFIG_PATH = join(homedir(), ".codex", "config.toml");
const CLAUDE_SETTINGS_PATH = join(homedir(), ".claude", "settings.json");
const HOOK_CONFIG_PATH = join(CONFIG_DIR, "hook-config.json");
const PLUGIN_CONFIG_PATH = join(CONFIG_DIR, "config.json");

const MIN_CODEX = "0.130.0";

function meetsMinVersion(v: string, min: string): boolean {
  const p = (s: string) => s.split(".").map(Number);
  const [ma, mi, pa] = p(v);
  const [mma, mmi, mpa] = p(min);
  if (ma !== mma) return (ma ?? 0) > (mma ?? 0);
  if (mi !== mmi) return (mi ?? 0) > (mmi ?? 0);
  return (pa ?? 0) >= (mpa ?? 0);
}

function check(label: string, ok: boolean, detail?: string): boolean {
  const icon = ok ? "✅" : "❌";
  const suffix = detail ? `  (${detail})` : "";
  process.stdout.write(`  ${icon} ${label}${suffix}\n`);
  return ok;
}

function warn(label: string, detail?: string): void {
  const suffix = detail ? `  (${detail})` : "";
  process.stdout.write(`  ⚠️  ${label}${suffix}\n`);
}

function info(msg: string): void {
  process.stdout.write(`  ℹ️  ${msg}\n`);
}

export function registerDoctorCommand(parent: Command, _ctx: CliContext): void {
  parent
    .command("doctor")
    .description("Check CodexInfo configuration (read-only)")
    .option("--notify", "Send a concise diagnostic notification to the configured channel")
    .action(async (opts: { notify?: boolean }) => {
      process.stdout.write(`\n🩺 CodexInfo doctor\n${"─".repeat(40)}\n\n`);
      let allGreen = true;

      // ── Codex CLI ──────────────────────────────────────────────────────────
      process.stdout.write("Codex CLI\n");
      let codexVersion: string | null = null;
      try {
        const { stdout } = await execFile("codex", ["--version"], { timeout: 5000, shell: true });
        const match = stdout.match(/(\d+\.\d+\.\d+)/);
        codexVersion = match ? (match[1] ?? null) : null;
      } catch { /* not found */ }

      if (!check("codex binary found", codexVersion !== null, codexVersion ?? "not in PATH")) {
        allGreen = false;
      }
      if (codexVersion) {
        if (!check(`codex >= v${MIN_CODEX}`, meetsMinVersion(codexVersion, MIN_CODEX), `v${codexVersion}`)) {
          allGreen = false;
        }
      }

      // ── Codex notify path ─────────────────────────────────────────────────
      process.stdout.write("\nCodex notify path\n");
      const tomlExists = existsSync(CODEX_CONFIG_PATH);
      if (!check("~/.codex/config.toml exists", tomlExists)) {
        allGreen = false;
      }

      if (tomlExists) {
        const toml = readFileSync(CODEX_CONFIG_PATH, "utf8");
        const notifyKind = detectNotifyKind(toml);

        if (notifyKind === "codexinfo") {
          check("notify path: codexinfo-hook.js installed", true);
        } else if (notifyKind === "none") {
          if (!check("notify path: codexinfo-hook.js installed", false, "absent — run: openclaw codexinfo setup")) {
            allGreen = false;
          }
        } else if (notifyKind === "ext-agent-beta2") {
          warn("notify path: ext-agent β2 (hook_helper.py) — stale, causes duplicate notifications");
          warn("  Fix: run `openclaw codexinfo setup` to replace with CodexInfo notify");
          allGreen = false;
        } else {
          warn("notify path: unknown command already configured — conflict");
          warn("  Fix: run `openclaw codexinfo setup --force` to replace, or remove manually");
          allGreen = false;
        }

        // Stale Stop hook detection
        const hasMarkerBlock = toml.includes(CODEXINFO_MARKER_BEGIN);
        const hasStaleStop = hasMarkerBlock && toml.includes("[[hooks.Stop]]");
        if (hasStaleStop) {
          warn("[[hooks.Stop]]: stale (Phase 11/12) — causes 'hooks need review' warning in Codex");
          warn("  Fix: run `openclaw codexinfo setup` to migrate away");
          allGreen = false;
        } else {
          check("[[hooks.Stop]]: absent (correct for default mode)", true);
        }

        // PermissionRequest status
        const hasPermReq = hasMarkerBlock && toml.includes("[[hooks.PermissionRequest]]");
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
      }

      // ── CodexInfo config ───────────────────────────────────────────────────
      process.stdout.write("\nCodexInfo config\n");
      const hookConfigExists = existsSync(HOOK_CONFIG_PATH);
      if (!check("hook-config.json exists", hookConfigExists, HOOK_CONFIG_PATH)) {
        allGreen = false;
      }

      const pluginConfigExists = existsSync(PLUGIN_CONFIG_PATH);
      if (!check("plugin config exists", pluginConfigExists, PLUGIN_CONFIG_PATH)) {
        allGreen = false;
      }

      if (pluginConfigExists) {
        try {
          const raw = JSON.parse(readFileSync(PLUGIN_CONFIG_PATH, "utf8")) as Record<string, unknown>;
          check("token configured", typeof raw["token"] === "string" && (raw["token"] as string).length >= 16);
          const deliveries = raw["deliveries"];
          check(
            "deliveries configured",
            Array.isArray(deliveries) && deliveries.length > 0,
            Array.isArray(deliveries) ? `${deliveries.length} entry/entries` : "none",
          );
          const journal = raw["journal"] as Record<string, unknown> | undefined;
          info(`journal: ${journal?.["enabled"] !== false ? "enabled" : "disabled"}`);
        } catch {
          check("plugin config is valid JSON", false);
          allGreen = false;
        }
      }

      // ── Claude Code notification residue ──────────────────────────────────
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

      // ── Rate-limit probe ───────────────────────────────────────────────────
      process.stdout.write("\nRate-limit probe\n");
      if (codexVersion) {
        process.stdout.write("  ⏳ probing codex app-server (up to 6s)...\n");
        const usage = await probeRateLimits();
        if (check("rate-limit probe reachable", usage !== null)) {
          if (usage) {
            for (const b of usage.buckets) {
              const leftPct = 100 - b.usedPercent;
              info(`${b.windowLabel}: ${leftPct}% left`);
            }
          }
        } else {
          warn(
            "Rate-limit probe failed — notifications will lack rate-limit bars",
            "Ensure codex is logged in and reachable",
          );
        }
      } else {
        warn("Skipping rate-limit probe — codex not found");
      }

      process.stdout.write("\n");
      if (allGreen) {
        process.stdout.write("✅ All checks passed. CodexInfo is ready.\n\n");
      } else {
        process.stdout.write("❌ Some checks failed. Run `openclaw codexinfo setup` to fix.\n\n");
        process.exitCode = 1;
      }

      if (opts.notify) {
        // Build status report from findings gathered during this run.
        const tomlExists = existsSync(CODEX_CONFIG_PATH);
        let notifyInstalled = false;
        let permReqInstalled = false;
        let hookPath = "";
        let deliveriesConfigured = false;
        let channelDesc = "unknown";

        if (tomlExists) {
          const toml = readFileSync(CODEX_CONFIG_PATH, "utf8");
          notifyInstalled = detectNotifyKind(toml) === "codexinfo";
          const hasMarker = toml.includes(CODEXINFO_MARKER_BEGIN);
          permReqInstalled = hasMarker && toml.includes("[[hooks.PermissionRequest]]");
          const hookMatch = toml.match(/^notify\s*=\s*\[.*?,\s*"([^"]+codexinfo-hook\.js[^"]*)"\s*\]/m);
          hookPath = hookMatch?.[1] ?? "";
        }

        if (existsSync(PLUGIN_CONFIG_PATH)) {
          try {
            const cfg = JSON.parse(readFileSync(PLUGIN_CONFIG_PATH, "utf8")) as Record<string, unknown>;
            const deliveries = cfg["deliveries"] as unknown[] | undefined;
            deliveriesConfigured = Array.isArray(deliveries) && deliveries.length > 0;
            const routing = cfg["routing"] as Record<string, unknown> | undefined;
            channelDesc = routing?.["mode"] === "broadcast"
              ? "all"
              : ((routing?.["targetChannels"] as string[] | undefined) ?? []).join(", ") || "unknown";
          } catch { /* skip */ }
        }

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
    });
}
