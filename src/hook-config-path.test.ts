import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK_BIN = join(import.meta.dirname, "..", "bin", "codexinfo-hook.js");

function runHook(
  payload: Record<string, unknown>,
  env: Record<string, string> = {},
): { exitCode: number; stderr: string } {
  const result = spawnSync(
    process.execPath,
    [HOOK_BIN, JSON.stringify(payload)],
    {
      encoding: "utf8",
      timeout: 5000,
      env: { ...process.env, CODEXINFO_DEBUG: "1", ...env },
    },
  );
  return { exitCode: result.status ?? 1, stderr: result.stderr ?? "" };
}

describe("CODEXINFO_HOOK_CONFIG_PATH env var", () => {
  it("exits 0 silently when path points to non-existent file", () => {
    const missingPath = join(tmpdir(), `does-not-exist-${Date.now()}-codexinfo-hook-config.json`);
    const { exitCode, stderr } = runHook(
      { type: "agent-turn-complete", session_id: "test", turn_id: "t1", cwd: "/tmp" },
      { CODEXINFO_HOOK_CONFIG_PATH: missingPath },
    );
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
  });

  it("reads config from CODEXINFO_HOOK_CONFIG_PATH instead of default ~/.openclaw path", () => {
    const dir = join(tmpdir(), "codexinfo-hook-cfg-test-" + Date.now());
    mkdirSync(dir, { recursive: true });
    const cfgPath = join(dir, "hook-config.json");
    // Point to a non-listening port — hook will attempt connect, fail, exit 0
    writeFileSync(cfgPath, JSON.stringify({ gatewayUrl: "http://localhost:19999", token: "test-token-16chars" }));

    try {
      const { exitCode, stderr } = runHook(
        { type: "agent-turn-complete", session_id: "test-cfg-path", turn_id: "cfg-path-" + Date.now(), cwd: "/tmp" },
        { CODEXINFO_HOOK_CONFIG_PATH: cfgPath },
      );
      // Hook exits 0 regardless (non-delivery is non-fatal)
      expect(exitCode).toBe(0);
      // "dedupe=send" proves the hook read the config from the custom path and
      // proceeded past the "not configured" early exit — connection refused is expected
      expect(stderr).toContain("dedupe=send event=completion");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to default path when env var is not set (no config → silent exit)", () => {
    // Override HOME to a temp dir with no hook-config.json — proves default path is HOME-based
    const tempHome = join(tmpdir(), "codexinfo-no-config-home-" + Date.now());
    mkdirSync(tempHome, { recursive: true });
    try {
      const { exitCode, stderr } = runHook(
        { type: "agent-turn-complete", session_id: "test", turn_id: "t3", cwd: "/tmp" },
        { HOME: tempHome },
      );
      expect(exitCode).toBe(0);
      expect(stderr).toBe(""); // silent exit — not configured
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("falls back to default path when CODEXINFO_HOOK_CONFIG_PATH is empty string", () => {
    // Empty string must be treated as unset — CI env injection may set vars to ""
    const tempHome = join(tmpdir(), "codexinfo-empty-override-" + Date.now());
    mkdirSync(tempHome, { recursive: true });
    try {
      const { exitCode, stderr } = runHook(
        { type: "agent-turn-complete", session_id: "test", turn_id: "empty-override-" + Date.now(), cwd: "/tmp" },
        { HOME: tempHome, CODEXINFO_HOOK_CONFIG_PATH: "" },
      );
      expect(exitCode).toBe(0);
      expect(stderr).toBe(""); // falls back to HOME-based path which has no config → silent exit
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
