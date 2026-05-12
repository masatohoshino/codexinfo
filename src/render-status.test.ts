import { describe, it, expect } from "vitest";
import { renderStatusNotification } from "./render-status.js";
import type { SetupStatusReport } from "./setup-status.js";

const ALL_READY: SetupStatusReport = {
  channelDesc: "all",
  isAllReady: true,
  completion: { status: "ready" },
  rateLimit: { status: "ready" },
  approvalWait: { status: "disabled" },
};

const PENDING_SETUP: SetupStatusReport = {
  channelDesc: "telegram",
  isAllReady: false,
  completion: { status: "pending_action" },
  rateLimit: { status: "pending_action" },
  approvalWait: { status: "disabled" },
};

const APPROVAL_PENDING: SetupStatusReport = {
  channelDesc: "all",
  isAllReady: false,
  completion: { status: "ready" },
  rateLimit: { status: "ready" },
  approvalWait: { status: "pending_action" },
};

describe("renderStatusNotification", () => {
  it("all-ready: title is CodexInfo ready and shows channel", () => {
    const out = renderStatusNotification(ALL_READY, "setup");
    expect(out).toContain("🦞 CodexInfo ready");
    expect(out).toContain("Channel: all");
  });

  it("pending in setup context: title is CodexInfo setup", () => {
    const out = renderStatusNotification(PENDING_SETUP, "setup");
    expect(out).toContain("🦞 CodexInfo setup");
  });

  it("pending in status context: title is CodexInfo status (not setup, not ready)", () => {
    const out = renderStatusNotification(PENDING_SETUP, "status");
    expect(out).toContain("🦞 CodexInfo status");
    expect(out).not.toContain("🦞 CodexInfo ready");
    expect(out).not.toContain("🦞 CodexInfo setup");
  });

  it("completion and rateLimit ready lines present", () => {
    const out = renderStatusNotification(ALL_READY, "setup");
    expect(out).toContain("Complete: ✅ ready");
    expect(out).toContain("Rate limit: ✅ ready");
  });

  it("approvalWait disabled shows 'disabled'", () => {
    const out = renderStatusNotification(ALL_READY, "setup");
    expect(out).toContain("Approval wait: disabled");
  });

  it("approvalWait pending_action includes /hooks instructions with Press t step", () => {
    const out = renderStatusNotification(APPROVAL_PENDING, "setup");
    expect(out).toContain("Approval wait: ⚠️ action required");
    expect(out).toContain("/hooks");
    expect(out).toContain("Press t to trust");
    expect(out).toContain("Trust Trusted");
  });

  it("approvalWait ready → no Trust instructions shown", () => {
    const trusted: SetupStatusReport = {
      channelDesc: "all",
      isAllReady: true,
      completion: { status: "ready" },
      rateLimit: { status: "ready" },
      approvalWait: { status: "ready" },
    };
    const out = renderStatusNotification(trusted, "status");
    expect(out).not.toContain("Press t");
    expect(out).not.toContain("To enable approval-wait");
    expect(out).toContain("Approval wait: ✅ ready");
  });

  it("no secrets or tokens in output", () => {
    const out = renderStatusNotification(ALL_READY, "setup");
    expect(out).not.toMatch(/token|secret|password|api.?key/i);
  });

  it("channelDesc is rendered in output", () => {
    const out = renderStatusNotification(PENDING_SETUP, "setup");
    expect(out).toContain("Channel: telegram");
  });

  it("approvalWait pending + context doctor → title contains CodexInfo status", () => {
    const out = renderStatusNotification(APPROVAL_PENDING, "doctor");
    expect(out).toContain("🦞 CodexInfo status");
    expect(out).not.toContain("🦞 CodexInfo ready");
  });

  it("approvalWait pending + context status → title contains CodexInfo status", () => {
    const out = renderStatusNotification(APPROVAL_PENDING, "status");
    expect(out).toContain("🦞 CodexInfo status");
  });

  it("approvalWait pending + context setup → title contains CodexInfo setup", () => {
    const out = renderStatusNotification(APPROVAL_PENDING, "setup");
    expect(out).toContain("🦞 CodexInfo setup");
  });

  it("all ready → title contains CodexInfo ready", () => {
    const out = renderStatusNotification(ALL_READY, "setup");
    expect(out).toContain("🦞 CodexInfo ready");
    expect(out).not.toContain("🦞 CodexInfo setup");
  });

  it("error status shows error label", () => {
    const report: SetupStatusReport = {
      ...ALL_READY,
      isAllReady: false,
      completion: { status: "error", detail: "notify not installed" },
      rateLimit: { status: "error", detail: "notify not installed" },
    };
    const out = renderStatusNotification(report, "setup");
    expect(out).toContain("Complete: ❌ error");
    expect(out).toContain("notify not installed");
  });
});
