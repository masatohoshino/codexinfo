import type { FeatureStatus, NotificationStatus, SetupStatusReport } from "./setup-status.js";

const STATUS_ICON: Record<NotificationStatus, string> = {
  ready: "✅",
  pending_action: "⚠️",
  disabled: "—",
  error: "❌",
  unknown: "❓",
};

function featureLine(label: string, fs: FeatureStatus): string {
  switch (fs.status) {
    case "ready":          return `${label}: ✅ ready`;
    case "pending_action": return `${label}: ⚠️ action required`;
    case "disabled":       return `${label}: disabled`;
    case "error":          return `${label}: ❌ error${fs.detail ? ` — ${fs.detail}` : ""}`;
    default:               return `${label}: ${STATUS_ICON[fs.status] ?? "❓"} ${fs.status}`;
  }
}

export function renderStatusNotification(
  report: SetupStatusReport,
  context: "setup" | "status" | "doctor" = "setup",
): string {
  const hasPending =
    report.completion.status === "pending_action" ||
    report.rateLimit.status === "pending_action" ||
    report.approvalWait.status === "pending_action";

  const title = hasPending
    ? context === "setup" ? "🦞 CodexInfo setup" : "🦞 CodexInfo status"
    : "🦞 CodexInfo ready";

  const lines: string[] = [
    title,
    "",
    `Channel: ${report.channelDesc}`,
    featureLine("Complete", report.completion),
    featureLine("Rate limit", report.rateLimit),
    featureLine("Approval wait", report.approvalWait),
  ];

  if (report.approvalWait.status === "pending_action") {
    lines.push(
      "",
      "To enable approval-wait notifications:",
      "1. Open Codex",
      "2. Run /hooks",
      "3. Select \"PermissionRequest\"",
      "4. Press t to trust the CodexInfo hook",
      "5. Confirm \"Trust Trusted\" is shown",
      "",
      "Then run:",
      "  codexinfo doctor --notify",
    );
  }

  return lines.join("\n");
}
