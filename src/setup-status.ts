import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CODEX_CONFIG_PATH = join(homedir(), ".codex", "config.toml");

export type NotificationStatus = "ready" | "pending_action" | "disabled" | "error" | "unknown";

export interface FeatureStatus {
  status: NotificationStatus;
  detail?: string;
}

export interface SetupStatusReport {
  channelDesc: string;
  isAllReady: boolean;
  completion: FeatureStatus;
  rateLimit: FeatureStatus;
  approvalWait: FeatureStatus;
}

export interface BuildStatusParams {
  channelDesc: string;
  notifyInstalled: boolean;
  deliveriesConfigured: boolean;
  permReqInstalled: boolean;
  hookPath: string;
  /** @internal for testing only — overrides the default CODEX_CONFIG_PATH */
  _codexConfigPath?: string;
}

export function isTrustedInCodex(_hookPath: string, configPath: string = CODEX_CONFIG_PATH): boolean {
  try {
    if (!existsSync(configPath)) return false;
    const raw = readFileSync(configPath, "utf8");
    // Codex v0.130.0 persists hook trust inside config.toml under
    // [hooks.state."<cfg_path>:permission_request:<outer>:<inner>"]
    // with enabled = true and trusted_hash = "sha256:<hex>".
    const sectionRe = /\[hooks\.state\."[^"]*:permission_request:\d+:\d+"\]([\s\S]*?)(?=\n\[|$)/g;
    let m: RegExpExecArray | null;
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

export function buildSetupStatusReport(params: BuildStatusParams): SetupStatusReport {
  const { channelDesc, notifyInstalled, deliveriesConfigured, permReqInstalled, hookPath, _codexConfigPath } = params;
  const configPath = _codexConfigPath ?? CODEX_CONFIG_PATH;

  let completion: FeatureStatus;
  if (!notifyInstalled) {
    completion = { status: "error", detail: "notify not installed — run setup" };
  } else if (!deliveriesConfigured) {
    completion = { status: "pending_action", detail: "configure deliveries in OpenClaw plugin config" };
  } else {
    completion = { status: "ready" };
  }

  // Rate-limit notifications travel the same notify path.
  const rateLimit: FeatureStatus = completion.status === "ready"
    ? { status: "ready" }
    : { status: completion.status, detail: completion.detail };

  let approvalWait: FeatureStatus;
  if (!permReqInstalled) {
    approvalWait = { status: "disabled" };
  } else if (isTrustedInCodex(hookPath, configPath)) {
    approvalWait = { status: "ready" };
  } else {
    approvalWait = { status: "pending_action" };
  }

  const isAllReady =
    completion.status === "ready" &&
    (approvalWait.status === "ready" || approvalWait.status === "disabled");

  return { channelDesc, isAllReady, completion, rateLimit, approvalWait };
}
