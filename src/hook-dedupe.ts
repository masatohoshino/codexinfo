/**
 * Dedupe logic for codexinfo-hook.js, exported for testing.
 * The actual hook runner inlines equivalent logic to stay self-contained.
 * This module mirrors the JS implementation exactly.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile, stat, rm } from "node:fs/promises";
import { join } from "node:path";

export const STOP_TTL_MS = 10 * 60 * 1000;
export const WINDOW_TTL_MS = 10 * 1000;
export const PERM_TTL_MS = 2 * 60 * 1000;
export const APPROVAL_CWD_WINDOW_TTL_MS = 30_000; // 30s — coalesces PermReq + Path D double-fire

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export interface DedupeKey {
  type: string;
  key: string;
  ttl: number;
  atomic: boolean;
}

export function buildCompletionDedupeKeys(
  payload: Record<string, unknown>,
  nowMs: number = Date.now()
): DedupeKey[] {
  const turnId = (payload["turn_id"] ?? payload["turn-id"]) as string | undefined;
  const cwd = String(payload["cwd"] ?? "");
  const client = String(payload["client"] ?? "");
  const cwdHash = sha256(cwd);
  const keys: DedupeKey[] = [];

  if (turnId) {
    keys.push({
      type: "turn_id",
      key: sha256(`codexinfo:v1:completion:turn:${turnId}`),
      ttl: STOP_TTL_MS,
      atomic: true,
    });
  }

  if (client) {
    keys.push({
      type: "window",
      key: sha256(`codexinfo:v1:completion:window:${client}:${cwdHash}`),
      ttl: WINDOW_TTL_MS,
      atomic: !turnId,
    });
  }

  if (keys.length === 0) {
    const tsBucket60 = Math.floor(nowMs / 60000).toString();
    keys.push({
      type: "fallback",
      key: sha256(`codexinfo:v1:completion:fallback:${cwdHash}:${client}:${tsBucket60}`),
      ttl: 60 * 1000,
      atomic: true,
    });
  }

  return keys;
}

export async function isCompletionDuplicate(
  payload: Record<string, unknown>,
  dedupeDir: string,
  nowMs: number = Date.now()
): Promise<{ duplicate: boolean; by?: string }> {
  await mkdir(dedupeDir, { recursive: true });
  const keys = buildCompletionDedupeKeys(payload, nowMs);
  const primaryIdx = keys.findIndex((k) => k.atomic);
  const primary = keys[primaryIdx];
  const secondaries = keys.filter((_, i) => i !== primaryIdx);

  for (const { key, ttl, type } of secondaries) {
    const p = join(dedupeDir, `${key}.flag`);
    try {
      const s = await stat(p);
      if (nowMs - s.mtimeMs <= ttl) return { duplicate: true, by: type };
      await rm(p, { force: true }).catch(() => {});
    } catch { /* absent */ }
  }

  const primaryPath = join(dedupeDir, `${primary.key}.flag`);
  try {
    const s = await stat(primaryPath);
    if (nowMs - s.mtimeMs <= primary.ttl) return { duplicate: true, by: primary.type };
    await rm(primaryPath, { force: true }).catch(() => {});
  } catch { /* absent */ }

  try {
    await writeFile(primaryPath, "1", { flag: "wx" });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "EEXIST") return { duplicate: true, by: primary.type };
    return { duplicate: false };
  }

  for (const { key } of secondaries) {
    await writeFile(join(dedupeDir, `${key}.flag`), "1").catch(() => {});
  }

  return { duplicate: false };
}

export async function isPermDuplicate(
  key: string,
  dedupeDir: string,
  ttlMs: number = PERM_TTL_MS,
  nowMs: number = Date.now(),
): Promise<boolean> {
  await mkdir(dedupeDir, { recursive: true });
  const flagPath = join(dedupeDir, `${key}.flag`);
  try {
    try {
      const s = await stat(flagPath);
      if (nowMs - s.mtimeMs <= ttlMs) return true;
      await rm(flagPath, { force: true }).catch(() => {});
    } catch { /* absent */ }
    await writeFile(flagPath, "1", { flag: "wx" });
    return false;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "EEXIST") return true;
    return false;
  }
}

export function buildApprovalCwdWindowKey(cwd: string): string {
  return sha256(`codexinfo:v1:approval-cwd-window:${sha256(cwd)}`);
}

export function buildDedupeKeyForPermissionRequest(payload: Record<string, unknown>): string {
  const turnId = (payload["turn_id"] ?? payload["turn-id"]) as string | undefined;
  const toolUseId = (payload["tool_use_id"] ?? payload["tool-use-id"]) as string | undefined;
  const toolName = typeof payload["tool_name"] === "string" ? payload["tool_name"] : "";
  if (turnId && toolUseId) {
    return sha256(`perm:${turnId}:${toolUseId}`);
  }
  if (turnId) {
    const inputStr = JSON.stringify(payload["tool_input"] ?? {});
    return sha256(`perm:${turnId}:${toolName}:${inputStr}`);
  }
  const sessionId = String(payload["session_id"] ?? payload["thread-id"] ?? payload["thread_id"] ?? "");
  const inputStr = JSON.stringify(payload["tool_input"] ?? {});
  const tsBucket = Math.floor(Date.now() / PERM_TTL_MS).toString();
  return sha256(`perm:${sessionId}:${toolName}:${inputStr}:${tsBucket}`);
}
