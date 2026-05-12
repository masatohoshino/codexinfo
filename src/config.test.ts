import { describe, it, expect } from "vitest";
import { parseConfig, getActiveDeliveries } from "./config.js";

const VALID_MIN = {
  token: "a".repeat(16),
  deliveries: [{ channel: "telegram", to: "12345" }],
};

describe("parseConfig", () => {
  it("accepts valid minimal config", () => {
    const cfg = parseConfig(VALID_MIN);
    expect(cfg).not.toBeNull();
    expect(cfg!.token).toBe("a".repeat(16));
  });

  it("fills in defaults for optional fields", () => {
    const cfg = parseConfig(VALID_MIN);
    expect(cfg!.routing.mode).toBe("broadcast");
    expect(cfg!.routing.targetChannels).toEqual([]);
    expect(cfg!.journal.enabled).toBe(true);
    expect(cfg!.journal.retentionDays).toBe(7);
    expect(cfg!.diagnostics.enabled).toBe(false);
    expect(cfg!.display.weeklyResetFormat).toBe("date");
  });

  it("returns null for missing token", () => {
    const cfg = parseConfig({ deliveries: [{ channel: "telegram", to: "123" }] });
    expect(cfg).toBeNull();
  });

  it("returns null when token is too short", () => {
    const cfg = parseConfig({ token: "short", deliveries: [{ channel: "telegram", to: "123" }] });
    expect(cfg).toBeNull();
  });

  it("returns null for empty deliveries", () => {
    const cfg = parseConfig({ token: "a".repeat(16), deliveries: [] });
    expect(cfg).toBeNull();
  });

  it("returns null for non-object input", () => {
    expect(parseConfig(null)).toBeNull();
    expect(parseConfig("string")).toBeNull();
    expect(parseConfig(42)).toBeNull();
  });

  it("accepts channels routing mode", () => {
    const cfg = parseConfig({
      ...VALID_MIN,
      routing: { mode: "channels", targetChannels: ["telegram"] },
    });
    expect(cfg!.routing.mode).toBe("channels");
    expect(cfg!.routing.targetChannels).toEqual(["telegram"]);
  });

  it("accepts weekday-time weeklyResetFormat", () => {
    const cfg = parseConfig({ ...VALID_MIN, display: { weeklyResetFormat: "weekday-time" } });
    expect(cfg!.display.weeklyResetFormat).toBe("weekday-time");
  });

  it("returns null for invalid weeklyResetFormat", () => {
    const cfg = parseConfig({ ...VALID_MIN, display: { weeklyResetFormat: "invalid" } });
    expect(cfg).toBeNull();
  });

  it("accepts disabled journal", () => {
    const cfg = parseConfig({ ...VALID_MIN, journal: { enabled: false, retentionDays: 3 } });
    expect(cfg!.journal.enabled).toBe(false);
  });

  it("accepts enabled diagnostics with rawCapture", () => {
    const cfg = parseConfig({
      ...VALID_MIN,
      diagnostics: { enabled: true, retentionDays: 7, rawCapture: true },
    });
    expect(cfg!.diagnostics.enabled).toBe(true);
    expect(cfg!.diagnostics.rawCapture).toBe(true);
  });
});

describe("getActiveDeliveries", () => {
  const cfg = (overrides: object = {}) => ({
    token: "a".repeat(16),
    deliveries: [
      { channel: "telegram", to: "111" },
      { channel: "slack", to: "S222" },
    ],
    routing: { mode: "broadcast" as const, targetChannels: [] },
    journal: { enabled: true, retentionDays: 7 },
    diagnostics: { enabled: false, retentionDays: 7, rawCapture: false },
    display: { weeklyResetFormat: "date" as const },
    ...overrides,
  });

  it("returns all deliveries in broadcast mode", () => {
    const result = getActiveDeliveries(cfg());
    expect(result).toHaveLength(2);
  });

  it("filters to target channels in channels mode", () => {
    const result = getActiveDeliveries(
      cfg({ routing: { mode: "channels", targetChannels: ["telegram"] } }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.channel).toBe("telegram");
  });

  it("returns empty when channels mode has no matches", () => {
    const result = getActiveDeliveries(
      cfg({ routing: { mode: "channels", targetChannels: ["discord"] } }),
    );
    expect(result).toHaveLength(0);
  });

  it("can target multiple channels", () => {
    const result = getActiveDeliveries(
      cfg({ routing: { mode: "channels", targetChannels: ["telegram", "slack"] } }),
    );
    expect(result).toHaveLength(2);
  });
});
