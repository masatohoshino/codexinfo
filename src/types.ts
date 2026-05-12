export type CodexInfoEventType = "completion" | "approval-wait" | "rate-limit-reached";

export interface UsageBucket {
  windowLabel: string;
  usedPercent: number;
  resetsAt: string | null;
}

export interface UsageSnapshot {
  displayMode: "left" | "used";
  buckets: UsageBucket[];
}

export interface ApprovalInfo {
  descriptionLine: string;
}

export interface CodexInfoEvent {
  eventId: string;
  eventType: CodexInfoEventType;
  receivedAt: string;
  approval?: ApprovalInfo;
  usage?: UsageSnapshot;
}

export interface DeliveryEntry {
  channel: string;
  to: string;
}

export interface HookConfig {
  gatewayUrl: string;
  token: string;
}
