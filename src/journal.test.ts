import { describe, it, expect } from "vitest";
import { buildJournalEntry } from "./journal.js";
import { RATE_LIMIT_UNAVAILABLE_LINE } from "./render.js";
import type { CodexInfoEvent } from "./types.js";

function makeEvent(overrides: Partial<CodexInfoEvent> = {}): CodexInfoEvent {
  return {
    eventId: "test-event-id-abc123",
    eventType: "completion",
    receivedAt: "2026-05-13T10:00:00.000Z",
    ...overrides,
  };
}

describe("buildJournalEntry", () => {
  it("includes id field matching eventId", () => {
    const entry = buildJournalEntry(makeEvent());
    expect(entry["id"]).toBe("test-event-id-abc123");
  });

  it("includes text field when renderedText is provided", () => {
    const rendered = `✅ Codex complete\n${RATE_LIMIT_UNAVAILABLE_LINE}`;
    const entry = buildJournalEntry(makeEvent(), rendered);
    expect(entry["text"]).toBe(rendered);
  });

  it("omits text field when renderedText is not provided", () => {
    const entry = buildJournalEntry(makeEvent());
    expect("text" in entry).toBe(false);
  });

  it("text field contains unavailable line when probe was absent", () => {
    const rendered = `✅ Codex complete\n${RATE_LIMIT_UNAVAILABLE_LINE}`;
    const entry = buildJournalEntry(makeEvent(), rendered);
    expect(String(entry["text"])).toContain(RATE_LIMIT_UNAVAILABLE_LINE);
    expect(String(entry["text"])).not.toContain("█");
  });

  it("text field contains bar characters when usage was present", () => {
    const rendered = "✅ Codex complete\n5h ███████░░░ 73% left 01:24\nW  ██████░░░░ 58% left 17 May";
    const entry = buildJournalEntry(makeEvent(), rendered);
    expect(String(entry["text"])).toContain("█");
    expect(String(entry["text"])).toContain("5h");
    expect(String(entry["text"])).toContain("W");
    expect(String(entry["text"])).not.toContain(RATE_LIMIT_UNAVAILABLE_LINE);
  });

  it("includes approval data for approval-wait", () => {
    const ev = makeEvent({
      eventType: "approval-wait",
      approval: { descriptionLine: "Write file src/index.ts" },
    });
    const entry = buildJournalEntry(ev);
    expect(entry["event"]).toBe("approval-wait");
    expect((entry["approval"] as Record<string, unknown>)["promptText"]).toBe(
      "Write file src/index.ts",
    );
  });

  it("includes rateLimits when usage is present", () => {
    const ev = makeEvent({
      usage: {
        displayMode: "left",
        buckets: [
          { windowLabel: "5h", usedPercent: 27, resetsAt: "2026-05-13T15:00:00.000Z" },
          { windowLabel: "W", usedPercent: 42, resetsAt: null },
        ],
      },
    });
    const entry = buildJournalEntry(ev);
    const rl = entry["rateLimits"] as Record<string, unknown>;
    expect(rl["fiveHour"]).toBeDefined();
    expect(rl["weekly"]).toBeDefined();
    expect((rl["fiveHour"] as Record<string, unknown>)["leftPercent"]).toBe(73);
    expect((rl["weekly"] as Record<string, unknown>)["leftPercent"]).toBe(58);
  });

  it("omits rateLimits when usage is absent", () => {
    const entry = buildJournalEntry(makeEvent());
    expect("rateLimits" in entry).toBe(false);
  });
});
