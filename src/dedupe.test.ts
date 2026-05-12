import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDedupeKeyForStop,
  buildDedupeKeyForPermissionRequest,
  isDuplicate,
  STOP_TTL_MS,
  PERM_TTL_MS,
} from "./dedupe.js";

// ─── buildDedupeKeyForStop ───────────────────────────────────────────────────

describe("buildDedupeKeyForStop", () => {
  it("uses turn_id when present", () => {
    const key = buildDedupeKeyForStop({ turn_id: "abc", session_id: "s", cwd: "/x" });
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    // Same turn_id → same key
    expect(buildDedupeKeyForStop({ turn_id: "abc" })).toBe(key);
  });

  it("uses turn-id hyphenated variant", () => {
    const key1 = buildDedupeKeyForStop({ "turn-id": "xyz" });
    const key2 = buildDedupeKeyForStop({ turn_id: "xyz" });
    expect(key1).toBe(key2);
  });

  it("different turn_ids produce different keys", () => {
    const k1 = buildDedupeKeyForStop({ turn_id: "t1" });
    const k2 = buildDedupeKeyForStop({ turn_id: "t2" });
    expect(k1).not.toBe(k2);
  });

  it("without turn_id uses session+cwd+timebucket — same call produces same key", () => {
    const payload = { session_id: "s1", cwd: "/home/user" };
    const k1 = buildDedupeKeyForStop(payload);
    const k2 = buildDedupeKeyForStop(payload);
    expect(k1).toBe(k2);
  });

  it("without turn_id, different sessions produce different keys", () => {
    const k1 = buildDedupeKeyForStop({ session_id: "s1", cwd: "/a" });
    const k2 = buildDedupeKeyForStop({ session_id: "s2", cwd: "/a" });
    expect(k1).not.toBe(k2);
  });

  it("stop prefix separates key space from perm prefix", () => {
    const kStop = buildDedupeKeyForStop({ turn_id: "same" });
    const kPerm = buildDedupeKeyForPermissionRequest({ turn_id: "same", tool_use_id: "u1" });
    expect(kStop).not.toBe(kPerm);
  });
});

// ─── buildDedupeKeyForPermissionRequest ─────────────────────────────────────

describe("buildDedupeKeyForPermissionRequest", () => {
  it("uses turn_id + tool_use_id when both present", () => {
    const k = buildDedupeKeyForPermissionRequest({ turn_id: "t1", tool_use_id: "u1" });
    expect(k).toMatch(/^[a-f0-9]{64}$/);
    expect(buildDedupeKeyForPermissionRequest({ turn_id: "t1", tool_use_id: "u1" })).toBe(k);
  });

  it("different tool_use_ids within same turn produce different keys", () => {
    const k1 = buildDedupeKeyForPermissionRequest({ turn_id: "t1", tool_use_id: "u1" });
    const k2 = buildDedupeKeyForPermissionRequest({ turn_id: "t1", tool_use_id: "u2" });
    expect(k1).not.toBe(k2);
  });

  it("uses turn_id + tool_name + tool_input when tool_use_id absent", () => {
    const k1 = buildDedupeKeyForPermissionRequest({ turn_id: "t1", tool_name: "Bash", tool_input: { command: "ls" } });
    const k2 = buildDedupeKeyForPermissionRequest({ turn_id: "t1", tool_name: "Bash", tool_input: { command: "ls" } });
    expect(k1).toBe(k2);
  });

  it("same turn different tool produces different keys", () => {
    const k1 = buildDedupeKeyForPermissionRequest({ turn_id: "t1", tool_name: "Bash", tool_input: { command: "ls" } });
    const k2 = buildDedupeKeyForPermissionRequest({ turn_id: "t1", tool_name: "Edit", tool_input: { path: "/f" } });
    expect(k1).not.toBe(k2);
  });

  it("falls back to session+toolName+input+timebucket without turn_id", () => {
    const p = { session_id: "s", tool_name: "Bash", tool_input: { command: "ls" } };
    expect(buildDedupeKeyForPermissionRequest(p)).toBe(buildDedupeKeyForPermissionRequest(p));
  });
});

// ─── isDuplicate ─────────────────────────────────────────────────────────────

describe("isDuplicate", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "codexinfo-dedupe-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("first call returns false (not duplicate)", async () => {
    const result = await isDuplicate("key1", STOP_TTL_MS, tmpDir);
    expect(result).toBe(false);
  });

  it("second call with same key returns true (duplicate)", async () => {
    await isDuplicate("key2", STOP_TTL_MS, tmpDir);
    const result = await isDuplicate("key2", STOP_TTL_MS, tmpDir);
    expect(result).toBe(true);
  });

  it("different keys are independent", async () => {
    await isDuplicate("keyA", STOP_TTL_MS, tmpDir);
    const result = await isDuplicate("keyB", STOP_TTL_MS, tmpDir);
    expect(result).toBe(false);
  });

  it("expired flag is treated as fresh (not duplicate)", async () => {
    const shortTtl = 1; // 1ms — immediately expired
    await isDuplicate("key3", shortTtl, tmpDir);
    // wait for expiry
    await new Promise((r) => setTimeout(r, 10));
    const result = await isDuplicate("key3", shortTtl, tmpDir);
    expect(result).toBe(false);
  });

  it("stop and perm TTLs are correct values", () => {
    expect(STOP_TTL_MS).toBe(10 * 60 * 1000);
    expect(PERM_TTL_MS).toBe(2 * 60 * 1000);
  });
});
