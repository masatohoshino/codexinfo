import type { IncomingMessage, ServerResponse } from "node:http";
import { safeEqualSecret } from "openclaw/plugin-sdk/security-runtime";
import type { CodexInfoConfig } from "./config.js";
import { normalizeHookPayload } from "./normalize.js";
import type { CodexInfoEvent } from "./types.js";

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function extractBearer(req: IncomingMessage): string {
  const auth = Array.isArray(req.headers.authorization)
    ? (req.headers.authorization[0] ?? "")
    : (req.headers.authorization ?? "");
  if (auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice("bearer ".length).trim();
  }
  return "";
}

async function readJsonBody(req: IncomingMessage, maxBytes = 131072): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

export function createHookHandler(params: {
  config: CodexInfoConfig;
  onEvent: (event: CodexInfoEvent) => Promise<void>;
  logger?: { info?: (message: string) => void; error?: (message: string) => void };
}): (req: IncomingMessage, res: ServerResponse) => Promise<boolean | void> {
  const { config, onEvent, logger } = params;

  return async (req, res): Promise<boolean | void> => {
    if (req.method !== "POST") {
      writeJson(res, 405, { ok: false, error: "method not allowed" });
      return true;
    }

    const bearer = extractBearer(req);
    if (!bearer || !safeEqualSecret(config.token, bearer)) {
      writeJson(res, 401, { ok: false, error: "unauthorized" });
      return true;
    }

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      writeJson(res, 400, { ok: false, error: "invalid request body" });
      return true;
    }

    const event = normalizeHookPayload(body);
    if (!event) {
      writeJson(res, 400, { ok: false, error: "unrecognized event" });
      return true;
    }

    try {
      await onEvent(event);
    } catch (err) {
      logger?.error?.(`[codexinfo] event handler error: ${err instanceof Error ? err.message : String(err)}`);
      writeJson(res, 500, { ok: false, error: "delivery failed" });
      return true;
    }

    logger?.info?.(`[codexinfo] delivered ${event.eventType} ${event.eventId.slice(0, 8)}`);
    writeJson(res, 200, { ok: true, eventId: event.eventId });
    return true;
  };
}

export function createDeliverTextHandler(params: {
  config: CodexInfoConfig;
  onText: (text: string) => Promise<void>;
  logger?: { info?: (message: string) => void; error?: (message: string) => void };
}): (req: IncomingMessage, res: ServerResponse) => Promise<boolean | void> {
  const { config, onText, logger } = params;

  return async (req, res): Promise<boolean | void> => {
    if (req.method !== "POST") {
      writeJson(res, 405, { ok: false, error: "method not allowed" });
      return true;
    }

    const bearer = extractBearer(req);
    if (!bearer || !safeEqualSecret(config.token, bearer)) {
      writeJson(res, 401, { ok: false, error: "unauthorized" });
      return true;
    }

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      writeJson(res, 400, { ok: false, error: "invalid request body" });
      return true;
    }

    const text = (body as Record<string, unknown> | null)?.["text"];
    if (typeof text !== "string") {
      writeJson(res, 400, { ok: false, error: "body.text must be a non-empty string" });
      return true;
    }
    if (text.trim().length === 0) {
      writeJson(res, 400, { ok: false, error: "body.text is empty" });
      return true;
    }
    if (text.trim().length > 8192) {
      writeJson(res, 400, { ok: false, error: "body.text exceeds 8192 character limit" });
      return true;
    }

    try {
      await onText(text.trim());
    } catch (err) {
      logger?.error?.(`[codexinfo] deliver-text error: ${err instanceof Error ? err.message : String(err)}`);
      writeJson(res, 500, { ok: false, error: "delivery failed" });
      return true;
    }

    logger?.info?.("[codexinfo] deliver-text: sent");
    writeJson(res, 200, { ok: true });
    return true;
  };
}
