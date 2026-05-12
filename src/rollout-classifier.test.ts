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
  it("empty tail → completion", () => {
    expect(classifyRolloutTail("").result).toBe("completion");
  });

  it("only unrelated events → completion", () => {
    const tail = [otherLine(), otherLine()].join("\n");
    expect(classifyRolloutTail(tail).result).toBe("completion");
  });

  it("task_complete present → completion regardless of function_call", () => {
    const tail = [fcLine("exec_command"), tcLine()].join("\n");
    const r = classifyRolloutTail(tail);
    expect(r.result).toBe("completion");
  });

  it("function_call without task_complete → approval-wait with toolName", () => {
    const tail = [otherLine(), fcLine("exec_command"), otherLine()].join("\n");
    const r = classifyRolloutTail(tail);
    expect(r.result).toBe("approval-wait");
    expect(r.toolName).toBe("exec_command");
  });

  it("function_call followed by function_call_output → completion", () => {
    const tail = [fcLine("exec_command"), fcoLine()].join("\n");
    expect(classifyRolloutTail(tail).result).toBe("completion");
  });

  it("function_call_output clears pending, then new function_call → approval-wait", () => {
    const tail = [fcLine("first_tool"), fcoLine(), fcLine("second_tool")].join("\n");
    const r = classifyRolloutTail(tail);
    expect(r.result).toBe("approval-wait");
    expect(r.toolName).toBe("second_tool");
  });

  it("function_call name null fallback → approval-wait with toolName undefined-like", () => {
    const line = JSON.stringify({ type: "response_item", payload: { type: "function_call" } });
    const r = classifyRolloutTail(line);
    expect(r.result).toBe("approval-wait");
    expect(r.toolName).toBeUndefined();
  });

  it("task_complete after function_call_output → completion", () => {
    const tail = [fcLine("exec_command"), fcoLine(), tcLine()].join("\n");
    expect(classifyRolloutTail(tail).result).toBe("completion");
  });

  it("ignores incomplete JSON lines at tail boundary", () => {
    const partial = '{"type":"response_item","payload":{"type":"function_call","name":"to';
    const complete = fcLine("full_tool");
    const tail = [complete, partial].join("\n");
    // partial line is skipped; full_tool is pending
    const r = classifyRolloutTail(tail);
    expect(r.result).toBe("approval-wait");
    expect(r.toolName).toBe("full_tool");
  });

  it("blank lines are skipped", () => {
    const tail = "\n\n" + fcLine("bash_tool") + "\n\n";
    expect(classifyRolloutTail(tail).result).toBe("approval-wait");
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
    expect(classifyRolloutTail(tail).result).toBe("completion");
  });

  // Normal completion (no approval involved) — most common case
  it("normal completion without function_call → completion", () => {
    const tail = [otherLine(), otherLine(), tcLine()].join("\n");
    expect(classifyRolloutTail(tail).result).toBe("completion");
  });
});
