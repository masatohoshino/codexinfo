import { existsSync, readFileSync } from "node:fs";
import { rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import type { Command } from "commander";
import type { CliContext } from "./index.js";

const CONFIG_DIR = join(homedir(), ".openclaw", "codexinfo");
const HOOK_CONFIG_PATH = join(CONFIG_DIR, "hook-config.json");
const PLUGIN_CONFIG_PATH = join(CONFIG_DIR, "config.json");
const MANIFEST_PATH = join(CONFIG_DIR, "manifest.json");
const CODEX_CONFIG_PATH = join(homedir(), ".codex", "config.toml");

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

const MARKER_BEGIN = "# codexinfo-begin";
const MARKER_END = "# codexinfo-end";

export function removeCodexinfoHooks(toml: string): string {
  let result = toml;

  // Remove marker block (structured hooks, v0.1+)
  if (result.includes(MARKER_BEGIN)) {
    const beginIdx = result.indexOf(MARKER_BEGIN);
    const endIdx = result.indexOf(MARKER_END);
    if (endIdx >= 0) {
      const prefix = result.slice(0, beginIdx);
      const suffix = result.slice(endIdx + MARKER_END.length);
      result = prefix + suffix;
    }
  }

  // Remove CodexInfo notify line (v0.1.3+ default path)
  result = result.replace(/^# codexinfo notify[ \t]*\n/m, "");
  result = result.replace(/^notify\s*=\s*\[.*codexinfo-hook\.js.*\][ \t]*\n?/m, "");

  // Remove deprecated codex_hooks = true (CodexInfo-specific)
  result = result.replace(/^codex_hooks\s*=\s*true[ \t]*\n?/m, "");

  // Remove hooks = true only when no [[hooks.*]] sections remain
  if (!/^\[\[hooks\./m.test(result)) {
    result = result.replace(/^\s*hooks\s*=\s*true[ \t]*\n?/m, "");
  }

  // Remove empty [features] section
  result = result.replace(/^\[features\][ \t]*\n(?=\[|\n|$)/m, "");

  // Normalize excess blank lines
  return result.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

export function registerUninstallCommand(parent: Command, _ctx: CliContext): void {
  parent
    .command("uninstall")
    .description("Remove CodexInfo configuration (only removes what setup added)")
    .option("--yes", "Skip confirmation prompt")
    .option("--dry-run", "Preview what would be removed")
    .action(async (opts: { yes?: boolean; dryRun?: boolean }) => {
      process.stdout.write(`\n🗑️  CodexInfo uninstall\n${"─".repeat(40)}\n\n`);

      if (opts.dryRun) {
        process.stdout.write("⚠️  Dry-run mode — no changes will be made.\n\n");
      }

      if (!existsSync(MANIFEST_PATH)) {
        process.stdout.write("CodexInfo does not appear to be installed (no manifest found).\n\n");
        return;
      }

      let manifest: Record<string, unknown>;
      try {
        manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Record<string, unknown>;
      } catch {
        process.stderr.write("❌ Cannot read manifest. Aborting.\n");
        process.exit(1);
      }

      const addedKeys = (manifest["addedKeys"] as string[] | undefined) ?? [];
      const codexConfigPath = (manifest["codexConfigPath"] as string) ?? CODEX_CONFIG_PATH;

      const hasNotify = addedKeys.includes("notify");
      const hasHooks = addedKeys.some(
        (k) => k.startsWith("hooks.") || k === "hooks" || k === "codex_hooks",
      );
      const willTouchToml = (hasNotify || hasHooks) && existsSync(codexConfigPath);

      process.stdout.write("Will remove:\n");
      if (willTouchToml) {
        process.stdout.write(`  • codexinfo notify + hook entries from ${codexConfigPath}\n`);
      }
      process.stdout.write(`  • ${HOOK_CONFIG_PATH}\n`);
      process.stdout.write(`  • ${PLUGIN_CONFIG_PATH}\n`);
      process.stdout.write(`  • ${MANIFEST_PATH}\n`);
      process.stdout.write("\nWill NOT touch:\n");
      process.stdout.write("  • Other OpenClaw config\n");
      process.stdout.write("  • Codex auth or other Codex config\n");
      process.stdout.write("  • OpenClaw plugin install (use `openclaw plugins uninstall codexinfo`)\n\n");

      if (!opts.yes && !opts.dryRun) {
        const answer = await ask("Proceed? [y/N] ");
        if (answer.toLowerCase() !== "y") {
          process.stdout.write("Cancelled.\n");
          return;
        }
      }

      if (opts.dryRun) {
        process.stdout.write("✅ Dry-run complete. No files changed.\n\n");
        return;
      }

      if (willTouchToml) {
        try {
          const toml = await readFile(codexConfigPath, "utf8");
          const backup = `${codexConfigPath}.codexinfo-uninstall-backup-${Date.now()}`;
          await writeFile(backup, toml, "utf8");
          const updated = removeCodexinfoHooks(toml);
          await writeFile(codexConfigPath, updated, "utf8");
          process.stdout.write(`  • Removed codexinfo config from ${codexConfigPath}\n`);
          process.stdout.write(`  • Backup: ${backup}\n`);
        } catch (err) {
          process.stderr.write(`  ⚠️ Could not update ${codexConfigPath}: ${err}\n`);
        }
      }

      for (const p of [HOOK_CONFIG_PATH, PLUGIN_CONFIG_PATH, MANIFEST_PATH]) {
        if (existsSync(p)) {
          await rm(p, { force: true });
          process.stdout.write(`  • Removed ${p}\n`);
        }
      }

      process.stdout.write("\n✅ CodexInfo uninstalled.\n");
      process.stdout.write("  Run `openclaw plugins uninstall codexinfo` to remove the plugin package.\n\n");
    });
}
