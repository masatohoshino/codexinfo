import { describe, it, expect } from "vitest";
import { normalizeHookPayload, sanitizeCompletionDetail } from "./normalize.js";

const NOW = "2026-05-10T12:00:00.000Z";

const USAGE = {
  displayMode: "left",
  buckets: [
    { windowLabel: "5h", usedPercent: 40, resetsAt: "2026-05-10T15:00:00.000Z" },
    { windowLabel: "W", usedPercent: 10, resetsAt: "2026-05-17T00:00:00.000Z" },
  ],
};

describe("normalizeHookPayload", () => {
  it("returns null for non-object body", () => {
    expect(normalizeHookPayload(null, NOW)).toBeNull();
    expect(normalizeHookPayload("string", NOW)).toBeNull();
    expect(normalizeHookPayload(42, NOW)).toBeNull();
  });

  it("returns null when source !== codex", () => {
    expect(normalizeHookPayload({ source: "claude", event: "agent-turn-complete" }, NOW)).toBeNull();
    expect(normalizeHookPayload({ event: "agent-turn-complete" }, NOW)).toBeNull();
  });

  it("returns null for unknown event type", () => {
    expect(normalizeHookPayload({ source: "codex", event: "unknown-event" }, NOW)).toBeNull();
    expect(normalizeHookPayload({ source: "codex", event: "" }, NOW)).toBeNull();
  });

  it("normalizes agent-turn-complete to completion", () => {
    const ev = normalizeHookPayload({ source: "codex", event: "agent-turn-complete" }, NOW);
    expect(ev).not.toBeNull();
    expect(ev!.eventType).toBe("completion");
    expect(ev!.receivedAt).toBe(NOW);
    expect(ev!.approval).toBeUndefined();
  });

  it("normalizes completion alias", () => {
    const ev = normalizeHookPayload({ source: "codex", event: "completion" }, NOW);
    expect(ev!.eventType).toBe("completion");
  });

  it("normalizes rate-limit-reached", () => {
    const ev = normalizeHookPayload({ source: "codex", event: "rate-limit-reached" }, NOW);
    expect(ev!.eventType).toBe("rate-limit-reached");
  });

  it("normalizes permission-request to approval-wait", () => {
    const ev = normalizeHookPayload(
      { source: "codex", event: "permission-request", description: "Run tests?" },
      NOW,
    );
    expect(ev!.eventType).toBe("approval-wait");
    expect(ev!.approval).toBeDefined();
    expect(ev!.approval!.descriptionLine).toBe("Run tests?");
  });

  it("normalizes approval-wait alias", () => {
    const ev = normalizeHookPayload(
      { source: "codex", event: "approval-wait", description: "Run tests?" },
      NOW,
    );
    expect(ev!.eventType).toBe("approval-wait");
  });

  it("uses tool_input.description as highest priority", () => {
    const ev = normalizeHookPayload(
      {
        source: "codex",
        event: "permission-request",
        tool_name: "Bash",
        description: "top-level description",
        tool_input: { description: "From tool_input.", command: "npm test" },
      },
      NOW,
    );
    expect(ev!.approval!.descriptionLine).toBe("From tool_input.");
  });

  it("uses description over tool_name fallback", () => {
    const ev = normalizeHookPayload(
      { source: "codex", event: "permission-request", description: "Custom prompt.", tool_name: "Bash" },
      NOW,
    );
    expect(ev!.approval!.descriptionLine).toBe("Custom prompt.");
  });

  it("falls back to Bash tool_name", () => {
    const ev = normalizeHookPayload(
      { source: "codex", event: "permission-request", tool_name: "Bash" },
      NOW,
    );
    expect(ev!.approval!.descriptionLine).toBe("Bash command requires approval.");
  });

  it("classifies Bash curl command as network access", () => {
    const ev = normalizeHookPayload(
      {
        source: "codex",
        event: "permission-request",
        tool_name: "Bash",
        tool_input: { command: "curl -I https://example.com" },
      },
      NOW,
    );
    expect(ev!.approval!.descriptionLine).toBe("Network access requires approval.");
  });

  it("classifies Bash wget command as network access", () => {
    const ev = normalizeHookPayload(
      {
        source: "codex",
        event: "permission-request",
        tool_name: "Bash",
        tool_input: { command: "wget https://example.com/file.tar.gz" },
      },
      NOW,
    );
    expect(ev!.approval!.descriptionLine).toBe("Network access requires approval.");
  });

  it("classifies Bash https:// URL as network access", () => {
    const ev = normalizeHookPayload(
      {
        source: "codex",
        event: "permission-request",
        tool_name: "Bash",
        tool_input: { command: "node -e \"fetch('https://api.example.com/data')\"" },
      },
      NOW,
    );
    expect(ev!.approval!.descriptionLine).toBe("Network access requires approval.");
  });

  it("non-network Bash command stays as Bash command requires approval", () => {
    const ev = normalizeHookPayload(
      {
        source: "codex",
        event: "permission-request",
        tool_name: "Bash",
        tool_input: { command: "rm -rf /tmp/build" },
      },
      NOW,
    );
    expect(ev!.approval!.descriptionLine).toBe("Bash command requires approval.");
  });

  it("tool_input.description takes priority over network command classification", () => {
    const ev = normalizeHookPayload(
      {
        source: "codex",
        event: "permission-request",
        tool_name: "Bash",
        tool_input: { description: "Check HTTPS connectivity.", command: "curl -I https://example.com" },
      },
      NOW,
    );
    expect(ev!.approval!.descriptionLine).toBe("Check HTTPS connectivity.");
  });

  it("falls back to Edit tool_name", () => {
    const ev = normalizeHookPayload(
      { source: "codex", event: "permission-request", tool_name: "Edit" },
      NOW,
    );
    expect(ev!.approval!.descriptionLine).toBe("File edit requires approval.");
  });

  it("falls back to apply_patch tool_name", () => {
    const ev = normalizeHookPayload(
      { source: "codex", event: "permission-request", tool_name: "apply_patch" },
      NOW,
    );
    expect(ev!.approval!.descriptionLine).toBe("File edit requires approval.");
  });

  it("falls back to Write tool_name", () => {
    const ev = normalizeHookPayload(
      { source: "codex", event: "permission-request", tool_name: "Write" },
      NOW,
    );
    expect(ev!.approval!.descriptionLine).toBe("File edit requires approval.");
  });

  it("falls back to mcp__ prefix", () => {
    const ev = normalizeHookPayload(
      { source: "codex", event: "permission-request", tool_name: "mcp__some_server__some_tool" },
      NOW,
    );
    expect(ev!.approval!.descriptionLine).toBe("MCP tool requires approval.");
  });

  it("falls back to generic message when no description or known tool_name", () => {
    const ev = normalizeHookPayload(
      { source: "codex", event: "permission-request" },
      NOW,
    );
    expect(ev!.approval!.descriptionLine).toBe("Codex requires approval.");
  });

  it("sanitizes multi-line description", () => {
    const ev = normalizeHookPayload(
      { source: "codex", event: "permission-request", description: "Run\ncommand\r\nhere" },
      NOW,
    );
    // [\r\n]+ collapses the whole sequence to a single space
    expect(ev!.approval!.descriptionLine).toBe("Run command here");
  });

  it("truncates description to 120 chars", () => {
    const longDesc = "x".repeat(200);
    const ev = normalizeHookPayload(
      { source: "codex", event: "permission-request", description: longDesc },
      NOW,
    );
    expect(ev!.approval!.descriptionLine.length).toBe(120);
  });

  it("parses usage snapshot", () => {
    const ev = normalizeHookPayload({ source: "codex", event: "agent-turn-complete", usage: USAGE }, NOW);
    expect(ev!.usage).toBeDefined();
    expect(ev!.usage!.buckets).toHaveLength(2);
    expect(ev!.usage!.buckets[0]!.usedPercent).toBe(40);
    expect(ev!.usage!.buckets[1]!.windowLabel).toBe("W");
  });

  it("ignores malformed usage", () => {
    const ev = normalizeHookPayload({ source: "codex", event: "agent-turn-complete", usage: { invalid: true } }, NOW);
    expect(ev!.usage).toBeUndefined();
  });

  it("ignores usage with empty buckets", () => {
    const ev = normalizeHookPayload(
      { source: "codex", event: "agent-turn-complete", usage: { displayMode: "left", buckets: [] } },
      NOW,
    );
    expect(ev!.usage).toBeUndefined();
  });

  it("assigns a non-empty eventId UUID", () => {
    const ev = normalizeHookPayload({ source: "codex", event: "agent-turn-complete" }, NOW);
    expect(typeof ev!.eventId).toBe("string");
    expect(ev!.eventId.length).toBeGreaterThan(0);
  });

  it("does not add approval to completion events", () => {
    const ev = normalizeHookPayload({ source: "codex", event: "agent-turn-complete", tool_name: "Bash" }, NOW);
    expect(ev!.approval).toBeUndefined();
  });

  it("extracts last_assistant_message as completionDetail for completion", () => {
    const ev = normalizeHookPayload(
      { source: "codex", event: "agent-turn-complete", last_assistant_message: "All tests pass." },
      NOW,
    );
    expect(ev!.completionDetail).toBe("All tests pass.");
  });

  it("accepts last-assistant-message (hyphen variant) as completionDetail", () => {
    const ev = normalizeHookPayload(
      { source: "codex", event: "agent-turn-complete", "last-assistant-message": "Done." },
      NOW,
    );
    expect(ev!.completionDetail).toBe("Done.");
  });

  it("does not set completionDetail when last_assistant_message is absent", () => {
    const ev = normalizeHookPayload({ source: "codex", event: "agent-turn-complete" }, NOW);
    expect(ev!.completionDetail).toBeUndefined();
  });

  it("does not set completionDetail for approval-wait events", () => {
    const ev = normalizeHookPayload(
      { source: "codex", event: "permission-request", last_assistant_message: "leaked" },
      NOW,
    );
    expect(ev!.completionDetail).toBeUndefined();
  });

  it("does not set completionDetail when last_assistant_message is empty string", () => {
    const ev = normalizeHookPayload(
      { source: "codex", event: "agent-turn-complete", last_assistant_message: "" },
      NOW,
    );
    expect(ev!.completionDetail).toBeUndefined();
  });
});

describe("sanitizeCompletionDetail", () => {
  it("returns clean short text as-is", () => {
    expect(sanitizeCompletionDetail("All tests pass.")).toBe("All tests pass.");
  });

  it("collapses multiline text to one line", () => {
    expect(sanitizeCompletionDetail("Line 1\nLine 2\nLine 3")).toBe("Line 1 Line 2 Line 3");
  });

  it("collapses CRLF line endings", () => {
    expect(sanitizeCompletionDetail("a\r\nb")).toBe("a b");
  });

  it("collapses multiple spaces/tabs", () => {
    expect(sanitizeCompletionDetail("a  b\t\tc")).toBe("a b c");
  });

  it("replaces code fence block with placeholder", () => {
    const r = sanitizeCompletionDetail("Here is the result:\n```ts\nconst x = 1;\n```\nDone.");
    expect(r).toBe("Here is the result: […] Done.");
  });

  it("replaces inline code fence block", () => {
    const r = sanitizeCompletionDetail("Result: ```code goes here``` end");
    expect(r).toBe("Result: […] end");
  });

  it("truncates text longer than 160 chars with ellipsis", () => {
    const long = "a".repeat(200);
    const r = sanitizeCompletionDetail(long)!;
    expect(r.length).toBe(160);
    expect(r.endsWith("…")).toBe(true);
  });

  it("returns null for empty string", () => {
    expect(sanitizeCompletionDetail("")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(sanitizeCompletionDetail("   \n\t  ")).toBeNull();
  });

  it("redacts JWT tokens", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyMTIzIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const r = sanitizeCompletionDetail(`Token: ${jwt}`);
    expect(r).toBe("Token: [token]");
    expect(r).not.toContain("eyJ");
  });

  it("redacts sk- style API keys", () => {
    const r = sanitizeCompletionDetail("key=sk-abcdefghij1234567890abcdef end");
    expect(r).not.toContain("sk-abcdefghij");
    expect(r).toContain("[api-key]");
  });

  it("redacts Telegram bot tokens (8-digit ID)", () => {
    const r = sanitizeCompletionDetail("bot=1234567890:AAFabc123def456ghi789jkl012mno345p end");
    expect(r).not.toContain("1234567890:AAF");
    expect(r).toContain("[bot-token]");
  });

  it("redacts Telegram bot tokens (6-digit ID — P2 fix)", () => {
    const r = sanitizeCompletionDetail("token 123456:AAFabc123def456ghi789jkl012mno345p here");
    expect(r).not.toContain("123456:AAF");
    expect(r).toContain("[bot-token]");
  });

  it("redacts Bearer token values (canonical case)", () => {
    const r = sanitizeCompletionDetail("Authorization: Bearer mysecrettoken123456789012345678");
    expect(r).toContain("Bearer [token]");
    expect(r).not.toContain("mysecrettoken");
  });

  it("redacts bearer token values (lowercase — P2 fix)", () => {
    const r = sanitizeCompletionDetail("Authorization: bearer mysecrettoken123456789012345678");
    expect(r).toContain("Bearer [token]");
    expect(r).not.toContain("mysecrettoken");
  });

  it("redacts BEARER token values (uppercase — P2 fix)", () => {
    const r = sanitizeCompletionDetail("BEARER mysecrettoken123456789012345678 end");
    expect(r).toContain("Bearer [token]");
    expect(r).not.toContain("mysecrettoken");
  });

  it("redacts GitHub gho_/ghu_/ghs_/ghr_ tokens (P3 fix)", () => {
    for (const prefix of ["gho", "ghu", "ghs", "ghr"]) {
      const token = `${prefix}_${"a".repeat(36)}`;
      const r = sanitizeCompletionDetail(`access ${token} end`);
      expect(r).not.toContain(token);
      expect(r).toContain("[api-key]");
    }
  });

  it("redacts Slack bot/user tokens (xoxb-/xoxp-)", () => {
    for (const prefix of ["xoxb", "xoxp", "xoxa", "xoxs"]) {
      const token = `${prefix}-${"A".repeat(12)}-${"B".repeat(12)}-${"C".repeat(12)}`;
      const r = sanitizeCompletionDetail(`token: ${token} here`);
      expect(r).not.toContain(token);
      expect(r).toContain("[api-key]");
    }
  });

  it("redacts AWS access key IDs (AKIA...)", () => {
    const r = sanitizeCompletionDetail("aws key AKIAIOSFODNN7EXAMPLE end");
    expect(r).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(r).toContain("[api-key]");
  });

  it("redacts Google API keys (AIza...)", () => {
    const key = `AIza${"A".repeat(35)}`;
    const r = sanitizeCompletionDetail(`key=${key} done`);
    expect(r).not.toContain(key);
    expect(r).toContain("[api-key]");
  });

  it("redacts GitLab personal access tokens (glpat-...)", () => {
    const r = sanitizeCompletionDetail("token glpat-abcdefghij1234567890 done");
    expect(r).not.toContain("glpat-abcdefghij");
    expect(r).toContain("[api-key]");
  });

  it("redacts npm tokens (npm_...)", () => {
    const token = `npm_${"A".repeat(36)}`;
    const r = sanitizeCompletionDetail(`publishing with ${token}`);
    expect(r).not.toContain(token);
    expect(r).toContain("[api-key]");
  });

  it("does not redact short normal words", () => {
    expect(sanitizeCompletionDetail("file sk-short")).toBe("file sk-short");
  });

  it("does not redact file paths", () => {
    const path = "/home/user/dev/project/src/normalize.ts";
    const r = sanitizeCompletionDetail(`Updated ${path}`);
    expect(r).toContain(path.slice(0, 20));
  });
});
