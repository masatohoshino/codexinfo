import { describe, it, expect, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import { createDeliverTextHandler } from "./http.js";

function makeReq(opts: { method?: string; body?: string; auth?: string }): IncomingMessage {
  const { method = "POST", body = "", auth = "Bearer correct-token" } = opts;
  const emitter = new EventEmitter() as IncomingMessage;
  (emitter as unknown as Record<string, unknown>).method = method;
  (emitter as unknown as Record<string, unknown>).headers = {
    authorization: auth || undefined,
    "content-length": String(Buffer.byteLength(body)),
  };

  // Schedule data/end events after the handler attaches listeners
  setImmediate(() => {
    if (body) emitter.emit("data", Buffer.from(body));
    emitter.emit("end");
  });

  return emitter;
}

function makeRes(): { res: ServerResponse; status: () => number; body: () => string } {
  let statusCode = 200;
  let bodyStr = "";
  const res = {
    get statusCode() { return statusCode; },
    set statusCode(v: number) { statusCode = v; },
    setHeader: vi.fn(),
    end: vi.fn((data?: string) => { if (data) bodyStr += data; }),
  } as unknown as ServerResponse;
  return { res, status: () => statusCode, body: () => bodyStr };
}

const CORRECT_TOKEN = "correct-token";
const makeHandler = (onText = vi.fn()) =>
  createDeliverTextHandler({
    config: { token: CORRECT_TOKEN } as Parameters<typeof createDeliverTextHandler>[0]["config"],
    onText,
    logger: { info: vi.fn(), error: vi.fn() },
  });

describe("createDeliverTextHandler", () => {
  it("returns 405 for GET", async () => {
    const handler = makeHandler();
    const { res, status } = makeRes();
    await handler(makeReq({ method: "GET" }), res);
    expect(status()).toBe(405);
  });

  it("returns 401 for wrong token", async () => {
    const handler = makeHandler();
    const { res, status } = makeRes();
    await handler(makeReq({ auth: "Bearer wrong-token", body: JSON.stringify({ text: "hello" }) }), res);
    expect(status()).toBe(401);
  });

  it("returns 401 for missing auth", async () => {
    const handler = makeHandler();
    const { res, status } = makeRes();
    await handler(makeReq({ auth: "", body: JSON.stringify({ text: "hello" }) }), res);
    expect(status()).toBe(401);
  });

  it("returns 400 for empty text", async () => {
    const handler = makeHandler();
    const { res, status } = makeRes();
    await handler(makeReq({ auth: `Bearer ${CORRECT_TOKEN}`, body: JSON.stringify({ text: "   " }) }), res);
    expect(status()).toBe(400);
  });

  it("returns 400 for oversized text", async () => {
    const handler = makeHandler();
    const { res, status } = makeRes();
    const bigText = "x".repeat(8193);
    await handler(makeReq({ auth: `Bearer ${CORRECT_TOKEN}`, body: JSON.stringify({ text: bigText }) }), res);
    expect(status()).toBe(400);
  });

  it("calls onText and returns 200 for valid request", async () => {
    const onText = vi.fn().mockResolvedValue(undefined);
    const handler = makeHandler(onText);
    const { res, status } = makeRes();
    await handler(makeReq({ auth: `Bearer ${CORRECT_TOKEN}`, body: JSON.stringify({ text: "hello world" }) }), res);
    expect(status()).toBe(200);
    expect(onText).toHaveBeenCalledWith("hello world");
  });
});
