import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import type { CliContext } from "./index.js";
import { buildSetupStatusReport } from "../setup-status.js";
import { renderStatusNotification } from "../render-status.js";
import { cliDeliverText, readCliHookConfig } from "./deliver-cli.js";
import { detectNotifyKind, CODEXINFO_MARKER_BEGIN } from "./setup.js";

const CONFIG_DIR = join(homedir(), ".openclaw", "codexinfo");
const PLUGIN_CONFIG_PATH = join(CONFIG_DIR, "config.json");
const MANIFEST_PATH = join(CONFIG_DIR, "manifest.json");
const CODEX_CONFIG_PATH = join(homedir(), ".codex", "config.toml");

export function registerStatusCommand(parent: Command, ctx: CliContext): void {
  parent
    .command("status")
    .description("Show current CodexInfo configuration and notification readiness (read-only)")
    .option("--notify", "Also send a status notification to the configured channel")
    .action(async (opts: { notify?: boolean }) => {
      process.stdout.write(`\n📊 CodexInfo status\n${"─".repeat(40)}\n\n`);

      if (!existsSync(PLUGIN_CONFIG_PATH)) {
        process.stdout.write("Not configured. Run: openclaw codexinfo setup\n\n");
        return;
      }

      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(readFileSync(PLUGIN_CONFIG_PATH, "utf8")) as Record<string, unknown>;
      } catch {
        process.stdout.write("❌ plugin config is not valid JSON.\n\n");
        return;
      }

      const routing = raw["routing"] as Record<string, unknown> | undefined;
      const mode = routing?.["mode"] ?? "unknown";
      const targetChannels = routing?.["targetChannels"] as string[] | undefined;
      const channelDesc =
        mode === "broadcast"
          ? "all"
          : `${(targetChannels ?? []).join(", ") || "(none)"}`;
      const channelDisplay =
        mode === "broadcast"
          ? "broadcast (all channels)"
          : `channels: ${(targetChannels ?? []).join(", ") || "(none)"}`;

      const deliveries = (raw["deliveries"] as Array<Record<string, unknown>> | undefined) ?? [];
      const journal = raw["journal"] as Record<string, unknown> | undefined;
      const journalEnabled = journal?.["enabled"] !== false;
      const diag = raw["diagnostics"] as Record<string, unknown> | undefined;
      const diagEnabled = diag?.["enabled"] === true;
      const display = raw["display"] as Record<string, unknown> | undefined;
      const weeklyFmt = (display?.["weeklyResetFormat"] as string) ?? "date";

      process.stdout.write(`Channel routing:  ${channelDisplay}\n`);
      process.stdout.write(`Deliveries:       ${deliveries.length} entry/entries\n`);
      for (const d of deliveries) {
        process.stdout.write(`  • ${d["channel"]} → (configured)\n`);
      }
      process.stdout.write(`Journal:          ${journalEnabled ? "enabled" : "disabled"}\n`);
      process.stdout.write(`Diagnostics:      ${diagEnabled ? "enabled" : "disabled"}\n`);
      process.stdout.write(`Weekly format:    ${weeklyFmt}\n`);

      if (existsSync(MANIFEST_PATH)) {
        try {
          const m = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Record<string, unknown>;
          process.stdout.write(`\nInstalled at:     ${m["installedAt"] ?? "unknown"}\n`);
          process.stdout.write(`Version:          ${m["version"] ?? "unknown"}\n`);
        } catch {
          /* skip */
        }
      }

      // ── Status model ───────────────────────────────────────────────────────
      process.stdout.write(`\n${"─".repeat(40)}\nNotification readiness\n${"─".repeat(40)}\n`);

      const tomlExists = existsSync(CODEX_CONFIG_PATH);
      let notifyInstalled = false;
      let permReqInstalled = false;
      let hookPath = "";

      if (tomlExists) {
        const toml = readFileSync(CODEX_CONFIG_PATH, "utf8");
        notifyInstalled = detectNotifyKind(toml) === "codexinfo";
        const hasMarker = toml.includes(CODEXINFO_MARKER_BEGIN);
        permReqInstalled = hasMarker && toml.includes("[[hooks.PermissionRequest]]");
        const hookMatch = toml.match(/^notify\s*=\s*\[.*?,\s*"([^"]+codexinfo-hook\.js[^"]*)"\s*\]/m);
        hookPath = hookMatch?.[1] ?? "";
      }

      // ctx.config comes from the gateway plugin config (authoritative when available).
      // deliveries in the local config.json may be stale or empty on fresh installs.
      const deliveriesConfigured =
        (ctx.config !== null && ctx.config.deliveries.length > 0) || deliveries.length > 0;

      const report = buildSetupStatusReport({
        channelDesc,
        notifyInstalled,
        deliveriesConfigured,
        permReqInstalled,
        hookPath,
      });

      const statusText = renderStatusNotification(report, "status");
      process.stdout.write(`${statusText}\n`);

      if (ctx.config === null) {
        process.stdout.write(
          "\n⚠️  Plugin config from OpenClaw not found — check `plugins.entries.codexinfo` in your OpenClaw config.\n",
        );
      }

      process.stdout.write("\n");

      if (opts.notify) {
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
          process.stderr.write("   Check: openclaw codexinfo doctor\n");
          process.exitCode = 1;
        }
      }
    });
}
