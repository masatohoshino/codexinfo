import { describe, it, expect } from "vitest";
import { classifyRolloutTail } from "./rollout-classifier.js";

// Minimal rollout line builders
function fcLine(name: string) {
  return JSON.stringify({ type: "response_item", payload: { type: "function_call", name } });
}
function fcoLine() {
  return JSON.stringify({ type: "response_item", payload: { type: "function_call_output" } });
}
function tcLine() {
  return JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } });
}
function otherLine() {
  return JSON.stringify({ type: "event_msg", payload: { type: "token_count", value: 42 } });
}

describe("classifyRolloutTail", () => {
  it("empty tail → completion, confirmed: false (timing-race sentinel)", () => {
    const r = classifyRolloutTail("");
    expect(r.result).toBe("completion");
    expect(r.confirmed).toBe(false);
  });

  it("only unrelated events → completion, confirmed: false", () => {
    const tail = [otherLine(), otherLine()].join("\n");
    const r = classifyRolloutTail(tail);
    expect(r.result).toBe("completion");
    expect(r.confirmed).toBe(false);
  });

  it("task_complete after function_call (same turn, no fco) → completion, confirmed: true", () => {
    const tail = [fcLine("exec_command"), tcLine()].join("\n");
    const r = classifyRolloutTail(tail);
    expect(r.result).toBe("completion");
    expect(r.confirmed).toBe(true);
  });

  it("function_call without task_complete → approval-wait with toolName, confirmed: true", () => {
    const tail = [otherLine(), fcLine("exec_command"), otherLine()].join("\n");
    const r = classifyRolloutTail(tail);
    expect(r.result).toBe("approval-wait");
    expect(r.toolName).toBe("exec_command");
    expect(r.confirmed).toBe(true);
  });

  it("function_call followed by function_call_output → completion, confirmed: false", () => {
    const tail = [fcLine("exec_command"), fcoLine()].join("\n");
    const r = classifyRolloutTail(tail);
    expect(r.result).toBe("completion");
    expect(r.confirmed).toBe(false);
  });

  it("function_call_output clears pending, then new function_call → approval-wait, confirmed: true", () => {
    const tail = [fcLine("first_tool"), fcoLine(), fcLine("second_tool")].join("\n");
    const r = classifyRolloutTail(tail);
    expect(r.result).toBe("approval-wait");
    expect(r.toolName).toBe("second_tool");
    expect(r.confirmed).toBe(true);
  });

  it("function_call name null fallback → approval-wait with toolName undefined-like, confirmed: true", () => {
    const line = JSON.stringify({ type: "response_item", payload: { type: "function_call" } });
    const r = classifyRolloutTail(line);
    expect(r.result).toBe("approval-wait");
    expect(r.toolName).toBeUndefined();
    expect(r.confirmed).toBe(true);
  });

  it("task_complete after function_call_output → completion, confirmed: true", () => {
    const tail = [fcLine("exec_command"), fcoLine(), tcLine()].join("\n");
    const r = classifyRolloutTail(tail);
    expect(r.result).toBe("completion");
    expect(r.confirmed).toBe(true);
  });

  it("ignores incomplete JSON lines at tail boundary", () => {
    const partial = '{"type":"response_item","payload":{"type":"function_call","name":"to';
    const complete = fcLine("full_tool");
    const tail = [complete, partial].join("\n");
    // partial line is skipped; full_tool is pending
    const r = classifyRolloutTail(tail);
    expect(r.result).toBe("approval-wait");
    expect(r.toolName).toBe("full_tool");
    expect(r.confirmed).toBe(true);
  });

  it("blank lines are skipped", () => {
    const tail = "\n\n" + fcLine("bash_tool") + "\n\n";
    const r = classifyRolloutTail(tail);
    expect(r.result).toBe("approval-wait");
    expect(r.confirmed).toBe(true);
  });

  // Simulates real Phase 17 approval-wait rollout tail (no task_complete at function_call time)
  it("Phase 17 approval-wait scenario: fc present, no fco, no tc → approval-wait", () => {
    const tail = [
      otherLine(), // token_count
      fcLine("exec_command"), // Codex requests approval
      // no function_call_output, no task_complete
    ].join("\n");
    const r = classifyRolloutTail(tail);
    expect(r.result).toBe("approval-wait");
    expect(r.toolName).toBe("exec_command");
    expect(r.confirmed).toBe(true);
  });

  // Simulates real Phase 17 completion rollout tail (task_complete present after approval)
  it("Phase 17 post-approval scenario: fc + fco + tc → completion", () => {
    const tail = [
      otherLine(),
      fcLine("exec_command"),
      fcoLine(),
      otherLine(),
      tcLine(),
    ].join("\n");
    const r = classifyRolloutTail(tail);
    expect(r.result).toBe("completion");
    expect(r.confirmed).toBe(true);
  });

  // Normal completion (no approval involved) — most common case
  it("normal completion without function_call → completion, confirmed: true", () => {
    const tail = [otherLine(), otherLine(), tcLine()].join("\n");
    const r = classifyRolloutTail(tail);
    expect(r.result).toBe("completion");
    expect(r.confirmed).toBe(true);
  });

  // Timing-race case: rollout exists but has no useful entries yet (VS Code hook fires early)
  it("pre-signal state (no fc, no tc) → completion, confirmed: false — retry sentinel", () => {
    const tail = [otherLine()].join("\n");
    const r = classifyRolloutTail(tail);
    expect(r.result).toBe("completion");
    expect(r.confirmed).toBe(false);
  });

  // Multi-turn rollout: previous turn's task_complete must not suppress current turn's function_call.
  // GPT-5.5 P2 regression: old task_complete followed by new function_call → approval-wait.
  it("previous-turn task_complete then new function_call → approval-wait, confirmed: true", () => {
    const tail = [tcLine(), otherLine(), fcLine("exec_command")].join("\n");
    const r = classifyRolloutTail(tail);
    expect(r.result).toBe("approval-wait");
    expect(r.toolName).toBe("exec_command");
    expect(r.confirmed).toBe(true);
  });

  // Normal: task_complete after function_call_output in same turn → completion.
  it("same-turn fc + fco + tc → completion, confirmed: true (order-aware)", () => {
    const tail = [fcLine("exec_command"), fcoLine(), tcLine()].join("\n");
    const r = classifyRolloutTail(tail);
    expect(r.result).toBe("completion");
    expect(r.confirmed).toBe(true);
  });

  // Phase 29 post-approval timing race (Step 1 of retry):
  // VS Code fires notify right after user approves. Codex has written function_call but not
  // function_call_output yet. Classifier must return approval-wait (triggers the Phase 29 retry).
  it("Phase 29 post-approval race (t+0): fc written, fco not yet — approval-wait, confirmed: true", () => {
    const tail = [otherLine(), fcLine("exec_command")].join("\n");
    const r = classifyRolloutTail(tail);
    expect(r.result).toBe("approval-wait");
    expect(r.toolName).toBe("exec_command");
    expect(r.confirmed).toBe(true);
  });

  // Phase 29 post-approval timing race (Step 2 of retry):
  // After 400ms retry, function_call_output has appeared but task_complete is not yet written.
  // Classifier returns completion, confirmed: false — safe to send completion notification.
  it("Phase 29 post-approval race (t+400ms): fc + fco written, tc pending — completion, confirmed: false", () => {
    const tail = [otherLine(), fcLine("exec_command"), fcoLine()].join("\n");
    const r = classifyRolloutTail(tail);
    expect(r.result).toBe("completion");
    expect(r.confirmed).toBe(false);
  });

  // Phase 29 post-approval timing race (fully resolved):
  // After 400ms retry, both function_call_output and task_complete appear.
  it("Phase 29 post-approval race (fully resolved): fc + fco + tc — completion, confirmed: true", () => {
    const tail = [otherLine(), fcLine("exec_command"), fcoLine(), otherLine(), tcLine()].join("\n");
    const r = classifyRolloutTail(tail);
    expect(r.result).toBe("completion");
    expect(r.confirmed).toBe(true);
  });
});
