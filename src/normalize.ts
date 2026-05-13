import { randomUUID } from "node:crypto";
import type { CodexInfoEvent, CodexInfoEventType, UsageSnapshot } from "./types.js";

function sanitize(s: string): string {
  return s.replace(/[\r\n]+/g, " ").trim().slice(0, 120);
}

const SECRET_PATTERNS: [RegExp, string][] = [
  // JWT (eyJ header)
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[token]"],
  // sk- style API keys (OpenAI, Anthropic)
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "[api-key]"],
  // GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_, github_pat_)
  [/\bgh[pousr]_[A-Za-z0-9]{36,}/g, "[api-key]"],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}/g, "[api-key]"],
  // Telegram bot tokens: 5-12 digits, colon, 30+ alphanum chars
  [/\b\d{5,12}:[A-Za-z0-9_-]{30,}/g, "[bot-token]"],
  // Bearer/bearer/BEARER token values (case-insensitive scheme)
  [/\bbearer\s+[A-Za-z0-9+/=_.-]{16,}/gi, "Bearer [token]"],
  // Slack bot/user/app tokens (xoxb-, xoxp-, xoxa-, xoxs-)
  [/\bxox[bpas]-[A-Za-z0-9_-]{10,}/g, "[api-key]"],
  // AWS access key IDs
  [/\bAKIA[A-Z0-9]{16}\b/g, "[api-key]"],
  // Google API keys (AIza prefix)
  [/\bAIza[A-Za-z0-9_-]{35}\b/g, "[api-key]"],
  // GitLab personal access tokens
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, "[api-key]"],
  // npm automation/publish tokens
  [/\bnpm_[A-Za-z0-9]{35,}/g, "[api-key]"],
];

const COMPLETION_DETAIL_MAX = 160;

export function sanitizeCompletionDetail(raw: string): string | null {
  // Replace markdown code fences (possibly multiline) before collapsing whitespace
  let s = raw.replace(/```[\s\S]*?```/g, "[…]");
  // Collapse all whitespace (newlines, tabs, runs of spaces) to a single space
  s = s.replace(/\s+/g, " ").trim();
  // Redact known secret patterns
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    s = s.replace(pattern, replacement);
  }
  // Cap at COMPLETION_DETAIL_MAX with an ellipsis
  if (s.length > COMPLETION_DETAIL_MAX) s = s.slice(0, COMPLETION_DETAIL_MAX - 1) + "…";
  return s.length > 0 ? s : null;
}

function resolveApprovalDescription(body: Record<string, unknown>): string {
  // Priority 1: tool_input.description (structured hook payload field)
  const toolInput = body["tool_input"];
  if (typeof toolInput === "object" && toolInput !== null) {
    const d = (toolInput as Record<string, unknown>)["description"];
    if (typeof d === "string") {
      const s = sanitize(d);
      if (s.length > 0) return s;
    }
  }

  // Priority 2: top-level description (direct POST / legacy)
  const description = typeof body["description"] === "string" ? body["description"] : null;
  if (description) {
    const s = sanitize(description);
    if (s.length > 0) return s;
  }

  // Priority 3: canonical tool_name classification
  const toolName = typeof body["tool_name"] === "string" ? body["tool_name"] : null;
  if (toolName === "Bash") {
    // Sub-classify by command content: simple deterministic keyword match only.
    const cmdStr =
      typeof toolInput === "object" && toolInput !== null
        ? String((toolInput as Record<string, unknown>)["command"] ?? "")
        : "";
    if (
      /\b(curl|wget|ssh|scp|nc|netcat|nmap|ping|traceroute)\b/i.test(cmdStr) ||
      /https?:\/\//i.test(cmdStr)
    ) {
      return "Network access requires approval.";
    }
    return "Bash command requires approval.";
  }
  if (toolName === "apply_patch" || toolName === "Edit" || toolName === "Write")
    return "File edit requires approval.";
  if (typeof toolName === "string" && toolName.startsWith("mcp__"))
    return "MCP tool requires approval.";

  return "Codex requires approval.";
}

function parseUsage(raw: unknown): UsageSnapshot | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const u = raw as Record<string, unknown>;
  if (u["displayMode"] !== "left" && u["displayMode"] !== "used") return undefined;
  if (!Array.isArray(u["buckets"])) return undefined;
  const buckets = (u["buckets"] as unknown[]).flatMap((b) => {
    if (typeof b !== "object" || b === null) return [];
    const bk = b as Record<string, unknown>;
    if (typeof bk["windowLabel"] !== "string") return [];
    if (typeof bk["usedPercent"] !== "number") return [];
    return [
      {
        windowLabel: bk["windowLabel"] as string,
        usedPercent: Math.round(bk["usedPercent"] as number),
        resetsAt: typeof bk["resetsAt"] === "string" ? bk["resetsAt"] : null,
      },
    ];
  });
  if (buckets.length === 0) return undefined;
  return { displayMode: u["displayMode"] as "left" | "used", buckets };
}

export function normalizeHookPayload(
  body: unknown,
  now: string = new Date().toISOString(),
): CodexInfoEvent | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;

  const source = b["source"];
  if (source !== "codex") return null;

  const event = typeof b["event"] === "string" ? b["event"] : null;
  if (!event) return null;

  let eventType: CodexInfoEventType;
  if (event === "agent-turn-complete" || event === "completion") {
    eventType = "completion";
  } else if (event === "rate-limit-reached") {
    eventType = "rate-limit-reached";
  } else if (event === "permission-request" || event === "approval-wait") {
    eventType = "approval-wait";
  } else {
    return null;
  }

  const usage = parseUsage(b["usage"]);

  const result: CodexInfoEvent = {
    eventId: randomUUID(),
    eventType,
    receivedAt: now,
    usage,
  };

  if (eventType === "approval-wait") {
    result.approval = { descriptionLine: resolveApprovalDescription(b) };
  }

  if (eventType === "completion") {
    const rawDetail = b["last_assistant_message"] ?? b["last-assistant-message"];
    if (typeof rawDetail === "string") {
      const detail = sanitizeCompletionDetail(rawDetail);
      if (detail) result.completionDetail = detail;
    }
  }

  return result;
}
