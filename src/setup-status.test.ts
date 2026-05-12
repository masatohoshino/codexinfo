import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSetupStatusReport } from "./setup-status.js";

const BASE = {
  channelDesc: "all",
  notifyInstalled: true,
  deliveriesConfigured: true,
  permReqInstalled: false,
  hookPath: "/some/path/codexinfo-hook.js",
};

// Helper: write a temp TOML fixture and return its path
const tempFiles: string[] = [];
function writeTempToml(content: string): string {
  const path = join(tmpdir(), `codexinfo-test-trust-${Date.now()}-${Math.random().toString(36).slice(2)}.toml`);
  writeFileSync(path, content);
  tempFiles.push(path);
  return path;
}
afterEach(() => {
  for (const p of tempFiles.splice(0)) {
    try { unlinkSync(p); } catch { /* best-effort */ }
  }
});

describe("buildSetupStatusReport", () => {
  it("all ready when notify + deliveries OK, no permReq", () => {
    const r = buildSetupStatusReport(BASE);
    expect(r.completion.status).toBe("ready");
    expect(r.rateLimit.status).toBe("ready");
    expect(r.approvalWait.status).toBe("disabled");
    expect(r.isAllReady).toBe(true);
    expect(r.channelDesc).toBe("all");
  });

  it("approval-wait pending_action when permReq installed but config.toml has no hooks.state entry", () => {
    const r = buildSetupStatusReport({
      ...BASE,
      permReqInstalled: true,
      _codexConfigPath: "/nonexistent/codex/config.toml",
    });
    expect(r.approvalWait.status).toBe("pending_action");
    expect(r.isAllReady).toBe(false);
  });

  it("completion error when notify not installed", () => {
    const r = buildSetupStatusReport({ ...BASE, notifyInstalled: false });
    expect(r.completion.status).toBe("error");
    expect(r.rateLimit.status).toBe("error");
    expect(r.isAllReady).toBe(false);
  });

  it("completion pending_action when deliveries not configured", () => {
    const r = buildSetupStatusReport({ ...BASE, deliveriesConfigured: false });
    expect(r.completion.status).toBe("pending_action");
    expect(r.rateLimit.status).toBe("pending_action");
    expect(r.isAllReady).toBe(false);
  });

  it("isAllReady false when completion is pending_action", () => {
    const r = buildSetupStatusReport({ ...BASE, deliveriesConfigured: false, permReqInstalled: false });
    expect(r.isAllReady).toBe(false);
  });

  it("channels: mode returns channel string in channelDesc", () => {
    const r = buildSetupStatusReport({ ...BASE, channelDesc: "telegram" });
    expect(r.channelDesc).toBe("telegram");
  });

  // Easy-setup acceptance criteria
  it("clean setup: notify + deliveries ready → completion and rateLimit both ready", () => {
    const r = buildSetupStatusReport({ ...BASE, notifyInstalled: true, deliveriesConfigured: true });
    expect(r.completion.status).toBe("ready");
    expect(r.rateLimit.status).toBe("ready");
  });

  it("approval hook installed but Trust not set → approvalWait pending_action (not disabled)", () => {
    const r = buildSetupStatusReport({
      ...BASE,
      permReqInstalled: true,
      _codexConfigPath: "/nonexistent/path/to/config.toml",
    });
    expect(r.approvalWait.status).toBe("pending_action");
    expect(r.approvalWait.status).not.toBe("disabled");
  });

  it("--no-approval-wait: permReqInstalled=false → approvalWait disabled only", () => {
    const r = buildSetupStatusReport({ ...BASE, permReqInstalled: false });
    expect(r.approvalWait.status).toBe("disabled");
  });

  it("isAllReady true when completion ready and approvalWait disabled (explicit opt-out)", () => {
    const r = buildSetupStatusReport({ ...BASE, permReqInstalled: false });
    expect(r.isAllReady).toBe(true);
  });

  it("isAllReady false when approvalWait pending_action (Trust not set)", () => {
    const r = buildSetupStatusReport({
      ...BASE,
      permReqInstalled: true,
      _codexConfigPath: "/nonexistent/path/config.toml",
    });
    expect(r.isAllReady).toBe(false);
  });

  // ── Trust detection via config.toml [hooks.state] ─────────────────────────

  it("trusted state in config.toml → approvalWait ready", () => {
    const path = writeTempToml(`
[hooks.state."/home/test/.codex/config.toml:permission_request:0:0"]
enabled = true
trusted_hash = "sha256:aabbccdd1122334455667788"
`);
    const r = buildSetupStatusReport({ ...BASE, permReqInstalled: true, _codexConfigPath: path });
    expect(r.approvalWait.status).toBe("ready");
    expect(r.isAllReady).toBe(true);
  });

  it("config.toml with hooks.state but enabled = false → approvalWait pending_action", () => {
    const path = writeTempToml(`
[hooks.state."/home/test/.codex/config.toml:permission_request:0:0"]
enabled = false
trusted_hash = "sha256:aabbccdd1122334455667788"
`);
    const r = buildSetupStatusReport({ ...BASE, permReqInstalled: true, _codexConfigPath: path });
    expect(r.approvalWait.status).toBe("pending_action");
  });

  it("config.toml with hooks.state but no trusted_hash → approvalWait pending_action", () => {
    const path = writeTempToml(`
[hooks.state."/home/test/.codex/config.toml:permission_request:0:0"]
enabled = true
`);
    const r = buildSetupStatusReport({ ...BASE, permReqInstalled: true, _codexConfigPath: path });
    expect(r.approvalWait.status).toBe("pending_action");
  });

  it("config.toml with stop hook state (not permission_request) → approvalWait pending_action", () => {
    const path = writeTempToml(`
[hooks.state."/home/test/.codex/config.toml:stop:0:0"]
enabled = true
trusted_hash = "sha256:aabbccdd1122334455667788"
`);
    const r = buildSetupStatusReport({ ...BASE, permReqInstalled: true, _codexConfigPath: path });
    expect(r.approvalWait.status).toBe("pending_action");
  });
});
