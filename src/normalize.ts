import { randomUUID } from "node:crypto";
import type { CodexInfoEvent, CodexInfoEventType, UsageSnapshot } from "./types.js";

function sanitize(s: string): string {
  return s.replace(/[\r\n]+/g, " ").trim().slice(0, 120);
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

  return result;
}
