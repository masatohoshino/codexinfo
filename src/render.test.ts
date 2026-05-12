import { describe, it, expect } from "vitest";
import { renderNotificationText } from "./render.js";
import type { CodexInfoEvent } from "./types.js";
import type { CodexInfoConfig } from "./config.js";

const BASE_CONFIG: Pick<CodexInfoConfig, "display"> = {
  display: { weeklyResetFormat: "date" },
};

const WEEKDAY_CONFIG: Pick<CodexInfoConfig, "display"> = {
  display: { weeklyResetFormat: "weekday-time" },
};

function makeEvent(
  eventType: CodexInfoEvent["eventType"],
  overrides: Partial<CodexInfoEvent> = {},
): CodexInfoEvent {
  return {
    eventId: "test-id",
    eventType,
    receivedAt: "2026-05-10T12:00:00.000Z",
    ...overrides,
  };
}

describe("renderNotificationText", () => {
  it("renders completion without usage", () => {
    const text = renderNotificationText(makeEvent("completion"), BASE_CONFIG);
    expect(text).toBe("✅ Codex complete");
  });

  it("renders rate-limit-reached header", () => {
    const text = renderNotificationText(makeEvent("rate-limit-reached"), BASE_CONFIG);
    expect(text.startsWith("⛔ Codex rate limit reached")).toBe(true);
  });

  it("renders approval-wait header with description", () => {
    const ev = makeEvent("approval-wait", {
      approval: { descriptionLine: "Run tests?" },
    });
    const text = renderNotificationText(ev, BASE_CONFIG);
    expect(text).toContain("⏸️ Codex waiting for approval");
    expect(text).toContain("Run tests?");
  });

  it("does not include blank approval line when no approval on approval-wait", () => {
    const ev = makeEvent("approval-wait");
    const text = renderNotificationText(ev, BASE_CONFIG);
    const lines = text.split("\n");
    expect(lines).toHaveLength(1); // just header
  });

  it("renders rate-limit bar for 5h bucket (60% left => 6 filled)", () => {
    const ev = makeEvent("completion", {
      usage: {
        displayMode: "left",
        buckets: [{ windowLabel: "5h", usedPercent: 40, resetsAt: null }],
      },
    });
    const text = renderNotificationText(ev, BASE_CONFIG);
    expect(text).toContain("██████░░░░");
    expect(text).toContain("60% left");
  });

  it("renders full bar (0% used => 100% left => 10 filled)", () => {
    const ev = makeEvent("completion", {
      usage: {
        displayMode: "left",
        buckets: [{ windowLabel: "5h", usedPercent: 0, resetsAt: null }],
      },
    });
    const text = renderNotificationText(ev, BASE_CONFIG);
    expect(text).toContain("██████████");
    expect(text).toContain("100% left");
  });

  it("renders empty bar (100% used => 0% left => 0 filled)", () => {
    const ev = makeEvent("completion", {
      usage: {
        displayMode: "left",
        buckets: [{ windowLabel: "5h", usedPercent: 100, resetsAt: null }],
      },
    });
    const text = renderNotificationText(ev, BASE_CONFIG);
    expect(text).toContain("░░░░░░░░░░");
    expect(text).toContain("0% left");
  });

  it("renders 5h reset as HH:MM duration", () => {
    const ev = makeEvent("completion", {
      receivedAt: "2026-05-10T12:00:00.000Z",
      usage: {
        displayMode: "left",
        buckets: [{ windowLabel: "5h", usedPercent: 40, resetsAt: "2026-05-10T14:30:00.000Z" }],
      },
    });
    const text = renderNotificationText(ev, BASE_CONFIG);
    expect(text).toContain("02:30");
  });

  it("renders weekly bucket as date by default", () => {
    const ev = makeEvent("completion", {
      receivedAt: "2026-05-10T12:00:00.000Z",
      usage: {
        displayMode: "left",
        buckets: [{ windowLabel: "W", usedPercent: 10, resetsAt: "2026-05-17T00:00:00.000Z" }],
      },
    });
    const text = renderNotificationText(ev, BASE_CONFIG);
    // resetsAt 2026-05-17 local date
    expect(text).toMatch(/\d+ \w{3}/); // e.g. "17 May"
  });

  it("renders weekly bucket as weekday-time when configured", () => {
    const ev = makeEvent("completion", {
      receivedAt: "2026-05-10T12:00:00.000Z",
      usage: {
        displayMode: "left",
        buckets: [{ windowLabel: "W", usedPercent: 10, resetsAt: "2026-05-17T09:00:00.000Z" }],
      },
    });
    const text = renderNotificationText(ev, WEEKDAY_CONFIG);
    // Should contain a 3-letter day abbreviation
    expect(text).toMatch(/(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d{2}:\d{2}/);
  });

  it("weekly label shows 'week' for rate-limit-reached, 'W' otherwise", () => {
    const makeWeeklyEvent = (type: CodexInfoEvent["eventType"]) =>
      makeEvent(type, {
        usage: {
          displayMode: "left",
          buckets: [{ windowLabel: "W", usedPercent: 100, resetsAt: null }],
        },
      });

    const completionText = renderNotificationText(makeWeeklyEvent("completion"), BASE_CONFIG);
    expect(completionText).toMatch(/^W\s/m);

    const rateLimitText = renderNotificationText(makeWeeklyEvent("rate-limit-reached"), BASE_CONFIG);
    expect(rateLimitText).toMatch(/^week\s/m);
  });

  it("label padding is 5 chars for rate-limit-reached", () => {
    const ev = makeEvent("rate-limit-reached", {
      usage: {
        displayMode: "left",
        buckets: [{ windowLabel: "5h", usedPercent: 50, resetsAt: null }],
      },
    });
    const text = renderNotificationText(ev, BASE_CONFIG);
    const barLine = text.split("\n").find((l) => l.includes("█"));
    expect(barLine).toBeDefined();
    // "5h   " (5 chars) followed by space
    expect(barLine!.startsWith("5h    ") || barLine!.startsWith("5h   ")).toBe(true);
  });

  it("label padding is 2 chars for completion", () => {
    const ev = makeEvent("completion", {
      usage: {
        displayMode: "left",
        buckets: [{ windowLabel: "5h", usedPercent: 50, resetsAt: null }],
      },
    });
    const text = renderNotificationText(ev, BASE_CONFIG);
    const barLine = text.split("\n").find((l) => l.includes("█"));
    expect(barLine).toBeDefined();
    // "5h" (2 chars) followed by space
    expect(barLine!.startsWith("5h ")).toBe(true);
  });

  it("renders multiple buckets", () => {
    const ev = makeEvent("completion", {
      usage: {
        displayMode: "left",
        buckets: [
          { windowLabel: "5h", usedPercent: 40, resetsAt: null },
          { windowLabel: "W", usedPercent: 10, resetsAt: null },
        ],
      },
    });
    const lines = renderNotificationText(ev, BASE_CONFIG).split("\n");
    expect(lines).toHaveLength(3); // header + 2 bar lines
  });

  it("skips usage section when no buckets", () => {
    const ev = makeEvent("completion");
    const text = renderNotificationText(ev, BASE_CONFIG);
    expect(text).toBe("✅ Codex complete");
  });
});
