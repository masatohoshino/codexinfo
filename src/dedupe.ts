import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { rm } from "node:fs/promises";

export const STOP_TTL_MS = 10 * 60 * 1000;   // 10 min — robust against VS Code double-fire
export const PERM_TTL_MS = 2 * 60 * 1000;    // 2 min — per-request dedup

export function resolveDedupeDir(): string {
  const xdg = process.env["XDG_CACHE_HOME"];
  if (xdg) return join(xdg, "codexinfo");
  const localAppData = process.env["LOCALAPPDATA"];
  if (localAppData) return join(localAppData, "codexinfo");
  return join(homedir(), ".cache", "codexinfo");
}

export function buildDedupeKeyForStop(payload: Record<string, unknown>): string {
  const turnId = payload["turn_id"] ?? payload["turn-id"];
  if (turnId) {
    return createHash("sha256").update(`stop:${turnId}`).digest("hex");
  }
  const sessionId = (payload["session_id"] ?? payload["thread-id"] ?? payload["thread_id"] ?? "") as string;
  const cwd = (payload["cwd"] ?? "") as string;
  const tsBucket = Math.floor(Date.now() / STOP_TTL_MS).toString();
  return createHash("sha256").update(`stop:${sessionId}:${cwd}:${tsBucket}`).digest("hex");
}

export function buildDedupeKeyForPermissionRequest(payload: Record<string, unknown>): string {
  const turnId = payload["turn_id"] ?? payload["turn-id"];
  const toolUseId = payload["tool_use_id"] ?? payload["tool-use-id"];
  const toolName = typeof payload["tool_name"] === "string" ? payload["tool_name"] : "";
  if (turnId && toolUseId) {
    return createHash("sha256").update(`perm:${turnId}:${toolUseId}`).digest("hex");
  }
  if (turnId) {
    const inputStr = JSON.stringify(payload["tool_input"] ?? {});
    return createHash("sha256").update(`perm:${turnId}:${toolName}:${inputStr}`).digest("hex");
  }
  const sessionId = (payload["session_id"] ?? payload["thread-id"] ?? payload["thread_id"] ?? "") as string;
  const inputStr = JSON.stringify(payload["tool_input"] ?? {});
  const tsBucket = Math.floor(Date.now() / PERM_TTL_MS).toString();
  return createHash("sha256").update(`perm:${sessionId}:${toolName}:${inputStr}:${tsBucket}`).digest("hex");
}

export async function isDuplicate(key: string, ttlMs: number, dir: string): Promise<boolean> {
  await mkdir(dir, { recursive: true });
  const flagPath = join(dir, `${key}.flag`);
  try {
    try {
      const s = await stat(flagPath);
      if (Date.now() - s.mtimeMs > ttlMs) {
        await rm(flagPath, { force: true });
        return false;
      }
    } catch {
      /* not found = proceed */
    }
    await writeFile(flagPath, "1", { flag: "wx" });
    return false;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "EEXIST") return true;
    return false;
  }
}
