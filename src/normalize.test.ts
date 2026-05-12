import { describe, it, expect } from "vitest";
import { normalizeHookPayload } from "./normalize.js";

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
});
