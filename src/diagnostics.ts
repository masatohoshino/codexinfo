import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DiagnosticsConfig } from "./config.js";

const DEFAULT_DIAG_DIR = join(homedir(), ".openclaw", "codexinfo-diagnostics");

export interface DiagnosticsLogger {
  write(entry: Record<string, unknown>): void;
  rotate(): void;
}

function diagFilePath(dir: string): string {
  const date = new Date().toISOString().slice(0, 10);
  return join(dir, `${date}.jsonl`);
}

export function createDiagnosticsLogger(cfg?: DiagnosticsConfig): DiagnosticsLogger {
  if (!cfg?.enabled) {
    return {
      write: () => undefined,
      rotate: () => undefined,
    };
  }

  if (cfg.rawCapture) {
    process.stderr.write(
      "[codexinfo] WARNING: diagnostics.rawCapture enabled — payload keys will be logged\n",
    );
  }

  const dir = cfg.logDir ?? DEFAULT_DIAG_DIR;

  return {
    write(entry: Record<string, unknown>): void {
      const line = JSON.stringify({ ...entry, _at: new Date().toISOString() }) + "\n";
      mkdir(dir, { recursive: true })
        .then(() => appendFile(diagFilePath(dir), line, "utf8"))
        .catch(() => undefined);
    },
    rotate(): void {
      /* retention cleanup omitted for v0.1 */
    },
  };
}
