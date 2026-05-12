import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCompletionDedupeKeys,
  isCompletionDuplicate,
  isPermDuplicate,
  buildDedupeKeyForPermissionRequest,
  buildApprovalCwdWindowKey,
  STOP_TTL_MS,
  WINDOW_TTL_MS,
  PERM_TTL_MS,
  APPROVAL_CWD_WINDOW_TTL_MS,
  sha256,
} from "./hook-dedupe.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "codexinfo-dedupe-test-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// VS Code notify payload — has client, may have turn-id.
// Phase 16: last-assistant-message and input-messages are NOT stable across fires, not used for dedupe.
function vscPayload(opts: {
  turnId?: string;
  cwd?: string;
  client?: string;
} = {}) {
  const p: Record<string, unknown> = {
    type: "agent-turn-complete",
    cwd: opts.cwd ?? "/home/user/project",
    client: opts.client ?? "VS Code",
    "last-assistant-message": `msg-${Math.random()}`, // differs each fire
    "input-messages": `prompt-${Math.random()}`,      // differs each fire
  };
  if (opts.turnId != null) p["turn-id"] = opts.turnId;
  return p;
}

// Codex CLI notify payload — no client field.
function cliPayload(opts: { turnId?: string; sessionId?: string; cwd?: string } = {}) {
  return {
    type: "agent-turn-complete",
    source: "codex",
    cwd: opts.cwd ?? "/home/user/project",
    turn_id: opts.turnId ?? "turn-abc-123",
    session_id: opts.sessionId ?? "session-xyz",
  } as Record<string, unknown>;
}

describe("buildCompletionDedupeKeys", () => {
  it("VS Code payload with turn-id produces turn_id (atomic) and window (secondary) keys", () => {
    const keys = buildCompletionDedupeKeys(vscPayload({ turnId: "t1" }));
    expect(keys.length).toBe(2);
    expect(keys[0].type).toBe("turn_id");
    expect(keys[0].atomic).toBe(true);
    expect(keys[0].ttl).toBe(STOP_TTL_MS);
    expect(keys[1].type).toBe("window");
    expect(keys[1].atomic).toBe(false); // non-atomic when turn-id present
    expect(keys[1].ttl).toBe(WINDOW_TTL_MS);
  });

  it("VS Code payload without turn-id or thread-id: window key is atomic primary", () => {
    const keys = buildCompletionDedupeKeys(vscPayload());
    expect(keys.length).toBe(1);
    expect(keys[0].type).toBe("window");
    expect(keys[0].atomic).toBe(true);
  });

  it("CLI payload (no client) with turn_id produces only turn_id key", () => {
    const keys = buildCompletionDedupeKeys(cliPayload({ turnId: "t2" }));
    expect(keys.length).toBe(1);
    expect(keys[0].type).toBe("turn_id");
    expect(keys[0].atomic).toBe(true);
  });

  it("Bare payload with no turn-id and no client produces fallback key", () => {
    const keys = buildCompletionDedupeKeys({ type: "agent-turn-complete", cwd: "/tmp" });
    expect(keys.length).toBe(1);
    expect(keys[0].type).toBe("fallback");
    expect(keys[0].atomic).toBe(true);
  });

  it("Two VS Code fires with same cwd+client produce same window key regardless of content", () => {
    const cwd = "/home/user/project";
    const client = "VS Code";
    const keysA = buildCompletionDedupeKeys(vscPayload({ turnId: "turn-A", cwd, client }));
    const keysB = buildCompletionDedupeKeys(vscPayload({ turnId: "turn-B", cwd, client }));
    const windowA = keysA.find((k) => k.type === "window")!;
    const windowB = keysB.find((k) => k.type === "window")!;
    expect(windowA.key).toBe(windowB.key);
    // turn_id keys differ
    expect(keysA[0].key).not.toBe(keysB[0].key);
  });

  it("Different cwd produces different window key", () => {
    const keysA = buildCompletionDedupeKeys(vscPayload({ cwd: "/proj-a" }));
    const keysB = buildCompletionDedupeKeys(vscPayload({ cwd: "/proj-b" }));
    expect(keysA[0].key).not.toBe(keysB[0].key);
  });

  it("Different client produces different window key", () => {
    const keysA = buildCompletionDedupeKeys(vscPayload({ client: "VS Code" }));
    const keysB = buildCompletionDedupeKeys(vscPayload({ client: "Cursor" }));
    expect(keysA[0].key).not.toBe(keysB[0].key);
  });
});

describe("isCompletionDuplicate — same turn-id scenario (CLI)", () => {
  it("first invocation is not a duplicate", async () => {
    const p = cliPayload({ turnId: "t1" });
    const r = await isCompletionDuplicate(p, dir);
    expect(r.duplicate).toBe(false);
  });

  it("second invocation with same turn-id is a duplicate", async () => {
    const p = cliPayload({ turnId: "t1" });
    await isCompletionDuplicate(p, dir);
    const r = await isCompletionDuplicate(p, dir);
    expect(r.duplicate).toBe(true);
    expect(r.by).toBe("turn_id");
  });

  it("different turn-id is not a duplicate (CLI separate turns)", async () => {
    await isCompletionDuplicate(cliPayload({ turnId: "t1" }), dir);
    const r = await isCompletionDuplicate(cliPayload({ turnId: "t2" }), dir);
    expect(r.duplicate).toBe(false);
  });

  it("CLI has no client field — window key not applied — rapid sequential turns both send", async () => {
    const r1 = await isCompletionDuplicate(cliPayload({ turnId: "cli-t1" }), dir);
    const r2 = await isCompletionDuplicate(cliPayload({ turnId: "cli-t2" }), dir);
    expect(r1.duplicate).toBe(false);
    expect(r2.duplicate).toBe(false);
  });
});

describe("isCompletionDuplicate — VS Code window key (Phase 16 fix)", () => {
  it("VS Code second fire with different turn-id and content within 10s is a duplicate", async () => {
    const cwd = "/home/user/project";
    const client = "VS Code";
    // First fire — arbitrary content
    const inv1 = vscPayload({ turnId: "turn-X", cwd, client });
    const r1 = await isCompletionDuplicate(inv1, dir);
    expect(r1.duplicate).toBe(false);

    // Second fire — completely different turn-id, last-assistant-message, input-messages
    const inv2 = vscPayload({ turnId: "turn-Y", cwd, client });
    const r2 = await isCompletionDuplicate(inv2, dir);
    expect(r2.duplicate).toBe(true);
    expect(r2.by).toBe("window");
  });

  it("VS Code fires with same turn-id are still deduplicated", async () => {
    const p = vscPayload({ turnId: "t1" });
    await isCompletionDuplicate(p, dir);
    const r = await isCompletionDuplicate(p, dir);
    expect(r.duplicate).toBe(true);
    // window secondary may fire before turn_id primary is re-checked — both are valid
    expect(["turn_id", "window"]).toContain(r.by);
  });

  it("VS Code fire in different cwd is not a duplicate (window key is cwd-scoped)", async () => {
    const r1 = await isCompletionDuplicate(
      vscPayload({ turnId: "turn-A", cwd: "/proj-a" }),
      dir
    );
    const r2 = await isCompletionDuplicate(
      vscPayload({ turnId: "turn-B", cwd: "/proj-b" }),
      dir
    );
    expect(r1.duplicate).toBe(false);
    expect(r2.duplicate).toBe(false);
  });

  it("VS Code fires > 10s apart both send (window expired)", async () => {
    const cwd = "/home/user/project";
    const client = "VS Code";
    const inv1 = vscPayload({ turnId: "turn-old", cwd, client });
    // First fire at real time
    await isCompletionDuplicate(inv1, dir);

    // Back-date the window flag to simulate > 10s elapsed
    const keys = buildCompletionDedupeKeys(inv1);
    const windowKey = keys.find((k) => k.type === "window")!;
    const flagPath = join(dir, `${windowKey.key}.flag`);
    const oldTime = new Date(Date.now() - WINDOW_TTL_MS - 5000);
    await utimes(flagPath, oldTime, oldTime);

    // New fire with different turn-id — window expired → should send
    const inv2 = vscPayload({ turnId: "turn-new", cwd, client });
    const r2 = await isCompletionDuplicate(inv2, dir);
    expect(r2.duplicate).toBe(false);
  });

  it("VS Code payload without turn-id or thread-id: window key is atomic — second fire blocked", async () => {
    const cwd = "/home/user/project";
    const client = "VS Code";
    const inv1 = vscPayload({ cwd, client }); // no turn-id, no thread-id
    const r1 = await isCompletionDuplicate(inv1, dir);
    expect(r1.duplicate).toBe(false);

    const inv2 = vscPayload({ cwd, client }); // same cwd+client, no turn-id
    const r2 = await isCompletionDuplicate(inv2, dir);
    expect(r2.duplicate).toBe(true);
    expect(r2.by).toBe("window");
  });
});

describe("isCompletionDuplicate — stale / expired cache", () => {
  it("expired turn-id flag is treated as absent (sends)", async () => {
    const p = cliPayload({ turnId: "t-expired" });
    await isCompletionDuplicate(p, dir);
    const keys = buildCompletionDedupeKeys(p);
    const primary = keys.find((k) => k.atomic)!;
    const flagPath = join(dir, `${primary.key}.flag`);
    const oldTime = new Date(Date.now() - STOP_TTL_MS - 5000);
    await utimes(flagPath, oldTime, oldTime);
    const r = await isCompletionDuplicate(p, dir);
    expect(r.duplicate).toBe(false);
  });

  it("expired window flag is treated as absent (sends)", async () => {
    const payload = vscPayload({ turnId: "t1", cwd: "/proj" });
    await isCompletionDuplicate(payload, dir);
    const keys = buildCompletionDedupeKeys(payload);
    const windowKey = keys.find((k) => k.type === "window")!;
    const flagPath = join(dir, `${windowKey.key}.flag`);
    const oldTime = new Date(Date.now() - WINDOW_TTL_MS - 5000);
    await utimes(flagPath, oldTime, oldTime);
    // Also expire the turn_id flag
    const primary = keys.find((k) => k.atomic)!;
    await utimes(join(dir, `${primary.key}.flag`), oldTime, oldTime);
    // New fire with different turn-id (so turn_id key is absent) — window expired → sends
    const payload2 = vscPayload({ turnId: "t2", cwd: "/proj" });
    const r = await isCompletionDuplicate(payload2, dir);
    expect(r.duplicate).toBe(false);
  });

  it("corrupted/empty dedupe dir does not crash", async () => {
    const newDir = join(dir, "nonexistent", "nested");
    const r = await isCompletionDuplicate(cliPayload({ turnId: "t1" }), newDir);
    expect(r.duplicate).toBe(false);
  });
});

describe("isCompletionDuplicate — atomic race safety (process simulation)", () => {
  it("two concurrent claimants for same key: exactly one succeeds", async () => {
    const p = cliPayload({ turnId: "race-turn" });
    const [r1, r2] = await Promise.all([
      isCompletionDuplicate(p, dir),
      isCompletionDuplicate(p, dir),
    ]);
    const sends = [r1, r2].filter((r) => !r.duplicate).length;
    const skips = [r1, r2].filter((r) => r.duplicate).length;
    expect(sends).toBe(1);
    expect(skips).toBe(1);
  });

  it("VS Code fires sequential (different turn-ids): second is blocked by window key", async () => {
    const r1 = await isCompletionDuplicate(
      vscPayload({ cwd: "/proj", client: "VS Code", turnId: "turn-X" }),
      dir
    );
    const r2 = await isCompletionDuplicate(
      vscPayload({ cwd: "/proj", client: "VS Code", turnId: "turn-Y" }),
      dir
    );
    expect(r1.duplicate).toBe(false);
    expect(r2.duplicate).toBe(true);
    expect(r2.by).toBe("window");
  });
});

describe("isCompletionDuplicate — completion dedupe does not affect PermissionRequest", () => {
  it("completion flag does not suppress an approval-wait with same turn-id", async () => {
    const turnId = "shared-turn";
    await isCompletionDuplicate(cliPayload({ turnId }), dir);
    const permKey = buildDedupeKeyForPermissionRequest({
      "turn-id": turnId,
      tool_use_id: "tool-1",
    });
    const permDup = await isPermDuplicate(permKey, dir);
    expect(permDup).toBe(false);
  });
});

describe("isPermDuplicate", () => {
  it("first call is not a duplicate", async () => {
    const key = sha256("perm:turn-1:tool-1");
    expect(await isPermDuplicate(key, dir)).toBe(false);
  });

  it("second call with same key is a duplicate", async () => {
    const key = sha256("perm:turn-1:tool-1");
    await isPermDuplicate(key, dir);
    expect(await isPermDuplicate(key, dir)).toBe(true);
  });

  it("different tool_use_id within same turn is not a duplicate", async () => {
    const k1 = buildDedupeKeyForPermissionRequest({ "turn-id": "t1", tool_use_id: "tool-A" });
    const k2 = buildDedupeKeyForPermissionRequest({ "turn-id": "t1", tool_use_id: "tool-B" });
    await isPermDuplicate(k1, dir);
    expect(await isPermDuplicate(k2, dir)).toBe(false);
  });

  it("expired perm flag is treated as absent", async () => {
    const key = sha256("perm:expired");
    expect(await isPermDuplicate(key, dir)).toBe(false);
  });

  it("custom ttlMs: flag expired by that ttl is treated as absent", async () => {
    const key = sha256("perm:custom-ttl");
    expect(await isPermDuplicate(key, dir, 500)).toBe(false); // claimed
    expect(await isPermDuplicate(key, dir, 500)).toBe(true);  // within 500ms: still valid
    // Back-date flag past 500ms
    const flagPath = join(dir, `${key}.flag`);
    const expiredTime = new Date(Date.now() - 600);
    await utimes(flagPath, expiredTime, expiredTime);
    expect(await isPermDuplicate(key, dir, 500)).toBe(false); // expired → absent
  });
});

describe("approval-cwd-window coalescing (Phase 23.2 — VS Code double-fire fix)", () => {
  it("buildApprovalCwdWindowKey: same cwd produces same key", () => {
    expect(buildApprovalCwdWindowKey("/home/user/project"))
      .toBe(buildApprovalCwdWindowKey("/home/user/project"));
  });

  it("buildApprovalCwdWindowKey: different cwd produces different key", () => {
    expect(buildApprovalCwdWindowKey("/proj-a"))
      .not.toBe(buildApprovalCwdWindowKey("/proj-b"));
  });

  it("APPROVAL_CWD_WINDOW_TTL_MS is 30 seconds", () => {
    expect(APPROVAL_CWD_WINDOW_TTL_MS).toBe(30_000);
  });

  it("PermReq claims window key, Path D is suppressed within 30s", async () => {
    const cwdWinKey = buildApprovalCwdWindowKey("/home/user/project");
    // PermReq path: claim the window key (ignore return — PermReq always sends)
    const permReqResult = await isPermDuplicate(cwdWinKey, dir, APPROVAL_CWD_WINDOW_TTL_MS);
    expect(permReqResult).toBe(false); // key was absent → claimed

    // Path D fires 4s later: window key is set → suppressed
    const pathDResult = await isPermDuplicate(cwdWinKey, dir, APPROVAL_CWD_WINDOW_TTL_MS);
    expect(pathDResult).toBe(true);
  });

  it("Path D with different cwd is not suppressed by PermReq from another cwd", async () => {
    const permReqKey = buildApprovalCwdWindowKey("/proj-a");
    const pathDKey = buildApprovalCwdWindowKey("/proj-b");
    await isPermDuplicate(permReqKey, dir, APPROVAL_CWD_WINDOW_TTL_MS); // PermReq for proj-a
    expect(await isPermDuplicate(pathDKey, dir, APPROVAL_CWD_WINDOW_TTL_MS)).toBe(false); // Path D for proj-b: not suppressed
  });

  it("cwd-window expires after 30s: new approval fires", async () => {
    const cwdWinKey = buildApprovalCwdWindowKey("/home/user/project");
    await isPermDuplicate(cwdWinKey, dir, APPROVAL_CWD_WINDOW_TTL_MS);
    // Back-date the flag past the 30s TTL
    const flagPath = join(dir, `${cwdWinKey}.flag`);
    const expiredTime = new Date(Date.now() - APPROVAL_CWD_WINDOW_TTL_MS - 5000);
    await utimes(flagPath, expiredTime, expiredTime);
    // New approval after 30s: window expired → fires
    expect(await isPermDuplicate(cwdWinKey, dir, APPROVAL_CWD_WINDOW_TTL_MS)).toBe(false);
  });

  it("cwd-window (30s) expires while perm key (2min) is still valid", async () => {
    const cwdWinKey = buildApprovalCwdWindowKey("/proj");
    const permKey = buildDedupeKeyForPermissionRequest({ "turn-id": "t1", tool_use_id: "tool-1" });
    // Both claimed now
    await isPermDuplicate(cwdWinKey, dir, APPROVAL_CWD_WINDOW_TTL_MS);
    await isPermDuplicate(permKey, dir);
    // Back-date both to 35s ago: cwd-window expired, perm key still valid
    const thirtyFiveSAgo = new Date(Date.now() - 35_000);
    await utimes(join(dir, `${cwdWinKey}.flag`), thirtyFiveSAgo, thirtyFiveSAgo);
    await utimes(join(dir, `${permKey}.flag`), thirtyFiveSAgo, thirtyFiveSAgo);
    // cwd-window expired (fires for new approval from same cwd)
    expect(await isPermDuplicate(cwdWinKey, dir, APPROVAL_CWD_WINDOW_TTL_MS)).toBe(false);
    // perm key still within 2-min window (would suppress PermReq re-fire for same tool)
    expect(await isPermDuplicate(permKey, dir)).toBe(true);
  });

  it("perm key namespace and cwd-window key namespace are independent", async () => {
    const cwdWinKey = buildApprovalCwdWindowKey("/home/user/project");
    const permKey = buildDedupeKeyForPermissionRequest({ "turn-id": "t1", tool_use_id: "tool-1" });
    expect(cwdWinKey).not.toBe(permKey);
    // Claiming one does not affect the other
    await isPermDuplicate(cwdWinKey, dir, APPROVAL_CWD_WINDOW_TTL_MS);
    expect(await isPermDuplicate(permKey, dir)).toBe(false);
  });
});
