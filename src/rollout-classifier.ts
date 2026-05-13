/**
 * Rollout JSONL tail classifier for no-trust approval-wait detection (Phase 19).
 *
 * VS Code fires the notify runner at function_call time (when Codex needs approval)
 * with the same event type it uses for task_complete. This module classifies the
 * rollout tail to distinguish approval-wait from genuine completion.
 *
 * Called from codexinfo-hook.js; exported here for unit testing.
 */

export interface RolloutClassification {
  result: "approval-wait" | "completion";
  toolName?: string;
  /**
   * true  = result is backed by an explicit signal (task_complete or function_call)
   * false = neither signal seen; VS Code timing-race possible (Codex may still be writing)
   */
  confirmed: boolean;
}

/**
 * Classify the tail text of a rollout JSONL file.
 *
 * Logic: scan lines for three event types:
 *   - response_item / function_call   → pending tool call (tracks toolName)
 *   - response_item / function_call_output → acknowledges pending call
 *   - event_msg / task_complete       → turn is done
 *
 * If the last function_call has no following function_call_output and there is
 * no task_complete, the turn is waiting for approval.
 */
export function classifyRolloutTail(tailText: string): RolloutClassification {
  const lines = tailText.split("\n");
  let hasTaskComplete = false;
  let hasPendingFunctionCall = false;
  let pendingToolName: string | undefined = undefined;

  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(t);
    } catch {
      continue; // incomplete JSON at tail boundary
    }
    const type = (obj as Record<string, unknown>)?.type;
    const payload = (obj as Record<string, unknown>)?.payload as Record<string, unknown> | undefined;
    const pt = payload?.type;

    if (type === "event_msg" && pt === "task_complete") {
      hasTaskComplete = true;
    }
    if (type === "response_item" && pt === "function_call") {
      hasPendingFunctionCall = true;
      hasTaskComplete = false; // new function_call supersedes any previous turn's task_complete
      pendingToolName = typeof payload?.name === "string" ? payload.name : undefined;
    }
    if (type === "response_item" && pt === "function_call_output") {
      hasPendingFunctionCall = false;
      pendingToolName = undefined;
    }
  }

  if (hasTaskComplete) return { result: "completion", confirmed: true };
  if (hasPendingFunctionCall) {
    return pendingToolName !== undefined
      ? { result: "approval-wait", toolName: pendingToolName, confirmed: true }
      : { result: "approval-wait", confirmed: true };
  }
  // Neither task_complete nor function_call seen — possible timing race (Codex still writing).
  return { result: "completion", confirmed: false };
}
