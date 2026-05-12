import { existsSync, readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";

const HOOK_CONFIG_PATH = join(homedir(), ".openclaw", "codexinfo", "hook-config.json");

export interface CliHookConfig {
  gatewayUrl: string;
  token: string;
}

export function readCliHookConfig(): CliHookConfig | null {
  try {
    if (!existsSync(HOOK_CONFIG_PATH)) return null;
    const raw = JSON.parse(readFileSync(HOOK_CONFIG_PATH, "utf8")) as Record<string, unknown>;
    const gatewayUrl = raw["gatewayUrl"];
    const token = raw["token"];
    if (typeof gatewayUrl !== "string" || typeof token !== "string") return null;
    return { gatewayUrl, token };
  } catch {
    return null;
  }
}

export async function cliDeliverText(params: {
  gatewayUrl: string;
  token: string;
  text: string;
}): Promise<{ ok: boolean; statusCode?: number; error?: string }> {
  const { gatewayUrl, token, text } = params;
  const body = JSON.stringify({ text });

  let urlObj: URL;
  try {
    urlObj = new URL("/plugins/codexinfo/deliver-text", gatewayUrl);
  } catch {
    return { ok: false, error: `invalid gateway URL: ${gatewayUrl}` };
  }

  const isHttps = urlObj.protocol === "https:";
  const requestFn = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve) => {
    const req = requestFn(
      {
        hostname: urlObj.hostname,
        port: urlObj.port || (isHttps ? "443" : "80"),
        path: urlObj.pathname + urlObj.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": Buffer.byteLength(body),
          Authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: string | Buffer) => { data += String(chunk); });
        res.on("end", () => {
          const statusCode = res.statusCode ?? 0;
          resolve(
            statusCode >= 200 && statusCode < 300
              ? { ok: true, statusCode }
              : { ok: false, statusCode, error: `HTTP ${statusCode}: ${data.slice(0, 120)}` },
          );
        });
      },
    );

    req.on("error", (err: Error) => resolve({ ok: false, error: err.message }));
    req.setTimeout(8000, () => {
      req.destroy();
      resolve({ ok: false, error: "request timeout (8s)" });
    });

    req.write(body);
    req.end();
  });
}
