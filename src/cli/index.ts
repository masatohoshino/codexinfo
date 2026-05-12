import type { Command } from "commander";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import type { CodexInfoConfig } from "../config.js";
import { registerSetupCommand } from "./setup.js";
import { registerDoctorCommand } from "./doctor.js";
import { registerStatusCommand } from "./status.js";
import { registerUninstallCommand } from "./uninstall.js";

export interface CliContext {
  program: Command;
  config: CodexInfoConfig | null;
  cfg: OpenClawConfig;
}

export function registerCodexinfoCli(ctx: CliContext): void {
  const { program } = ctx;
  const root = program.command("codexinfo").description("Manage CodexInfo Codex notifications");

  registerSetupCommand(root, ctx);
  registerDoctorCommand(root, ctx);
  registerStatusCommand(root, ctx);
  registerUninstallCommand(root, ctx);
}
