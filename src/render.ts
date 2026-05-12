import type { CodexInfoConfig } from "./config.js";
import type { CodexInfoEvent, CodexInfoEventType, UsageBucket, UsageSnapshot } from "./types.js";

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const ICON: Record<CodexInfoEventType, string> = {
  "completion": "✅",
  "approval-wait": "⏸️",
  "rate-limit-reached": "⛔",
};

const TITLE: Record<CodexInfoEventType, string> = {
  "completion": "Codex complete",
  "approval-wait": "Codex waiting for approval",
  "rate-limit-reached": "Codex rate limit reached",
};

function renderBar(filledCount: number): string {
  const n = Math.min(10, Math.max(0, filledCount));
  return "█".repeat(n) + "░".repeat(10 - n);
}

function formatDuration(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
}

function formatResetTime(
  resetsAt: string,
  receivedAt: string,
  weeklyResetFormat: "date" | "weekday-time",
  isWeeklyBucket: boolean,
): string {
  const reset = new Date(resetsAt);
  const received = new Date(receivedAt);
  const diffMs = reset.getTime() - received.getTime();
  const diffSecs = Math.max(0, Math.floor(diffMs / 1000));

  if (isWeeklyBucket && weeklyResetFormat === "weekday-time") {
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const day = days[reset.getDay()] ?? "?";
    const hh = reset.getHours().toString().padStart(2, "0");
    const mm = reset.getMinutes().toString().padStart(2, "0");
    return `${day} ${hh}:${mm}`;
  }

  if (isWeeklyBucket) {
    const day = reset.getDate();
    const mon = MONTH_NAMES[reset.getMonth()] ?? "?";
    return `${day} ${mon}`;
  }

  return formatDuration(diffSecs);
}

function isWeekly(label: string): boolean {
  return label === "W" || label === "week";
}

function renderBucketLine(
  bucket: UsageBucket,
  eventType: CodexInfoEventType,
  receivedAt: string,
  weeklyResetFormat: "date" | "weekday-time",
): string {
  const leftPct = 100 - bucket.usedPercent;
  const filledCount = Math.round(leftPct / 10);
  const bar = renderBar(filledCount);

  const weekly = isWeekly(bucket.windowLabel);
  const displayLabel =
    eventType === "rate-limit-reached" && weekly ? "week" : bucket.windowLabel;

  const labelPad = eventType === "rate-limit-reached" ? 5 : 2;
  const label = displayLabel.padEnd(labelPad);

  let line = `${label} ${bar} ${leftPct}% left`;
  if (bucket.resetsAt != null) {
    line += ` ${formatResetTime(bucket.resetsAt, receivedAt, weeklyResetFormat, weekly)}`;
  }
  return line;
}

function renderUsageBars(
  usage: UsageSnapshot,
  event: CodexInfoEvent,
  weeklyResetFormat: "date" | "weekday-time",
): string[] {
  return usage.buckets.map((b) =>
    renderBucketLine(b, event.eventType, event.receivedAt, weeklyResetFormat),
  );
}

export function renderNotificationText(
  event: CodexInfoEvent,
  config: Pick<CodexInfoConfig, "display">,
): string {
  const icon = ICON[event.eventType];
  const title = TITLE[event.eventType];
  const lines: string[] = [`${icon} ${title}`];

  if (event.eventType === "approval-wait" && event.approval) {
    lines.push(event.approval.descriptionLine);
  }

  if (event.usage && event.usage.buckets.length > 0) {
    const barLines = renderUsageBars(
      event.usage,
      event,
      config.display.weeklyResetFormat,
    );
    lines.push(...barLines);
  }

  return lines.join("\n");
}
