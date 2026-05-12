import { describe, it, expect } from "vitest";
import {
  applyCodexinfoConfig,
  detectNotifyKind,
  parseChannels,
  meetsMinVersion,
  CODEXINFO_MARKER_BEGIN,
  CODEXINFO_MARKER_END,
} from "./cli/setup.js";
import { removeCodexinfoHooks } from "./cli/uninstall.js";

const NODE = "/usr/bin/node";
const HOOK = "/home/user/.openclaw/extensions/codexinfo/bin/codexinfo-hook.js";

function apply(toml: string, opts?: { approvalWait?: boolean; force?: boolean }) {
  return applyCodexinfoConfig(toml, NODE, HOOK, opts?.approvalWait ?? false, opts?.force ?? false);
}

// Helper: build a stale Phase 11/12 toml (Stop + PermissionRequest structured hooks)
function makeStaleToml(base = ""): string {
  const hookCmd = `"${NODE} ${HOOK}"`;
  const block = [
    CODEXINFO_MARKER_BEGIN,
    "[[hooks.Stop]]",
    "",
    "[[hooks.Stop.hooks]]",
    `type    = "command"`,
    `command = ${hookCmd}`,
    "timeout = 30",
    "",
    "[[hooks.PermissionRequest]]",
    "",
    "[[hooks.PermissionRequest.hooks]]",
    `type    = "command"`,
    `command = ${hookCmd}`,
    "timeout = 30",
    CODEXINFO_MARKER_END,
    "",
  ].join("\n");
  return base + (base && !base.endsWith("\n") ? "\n" : "") + "\n[features]\nhooks = true\n\n" + block;
}

// ─── detectNotifyKind ────────────────────────────────────────────────────────

describe("detectNotifyKind", () => {
  it("returns none when no notify line", () => {
    expect(detectNotifyKind('model = "o4"\n')).toBe("none");
  });

  it("returns codexinfo when notify contains codexinfo-hook.js", () => {
    expect(detectNotifyKind(`notify = ["/usr/bin/node", "${HOOK}"]\n`)).toBe("codexinfo");
  });

  it("returns ext-agent-beta2 when notify contains hook_helper.py", () => {
    expect(detectNotifyKind('notify = ["python3", "/path/to/hook_helper.py"]\n')).toBe("ext-agent-beta2");
  });

  it("returns unknown for unrecognised notify command", () => {
    expect(detectNotifyKind('notify = ["some-other-cmd"]\n')).toBe("unknown");
  });

  it("returns none on empty toml", () => {
    expect(detectNotifyKind("")).toBe("none");
  });
});

// ─── applyCodexinfoConfig — default mode ────────────────────────────────────

describe("applyCodexinfoConfig default mode", () => {
  it("installs notify, no Stop, no PermissionRequest", () => {
    const r = apply("");
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.toml).toContain("# codexinfo notify");
    expect(r.toml).toContain("notify = [");
    expect(r.toml).toContain(HOOK);
    expect(r.toml).not.toContain("[[hooks.Stop]]");
    expect(r.toml).not.toContain("[[hooks.PermissionRequest]]");
  });

  it("does not add hooks = true in default mode", () => {
    const r = apply("");
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.toml).not.toContain("hooks = true");
  });

  it("preserves existing TOML content", () => {
    const r = apply('model = "o4-mini"\n');
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.toml).toContain('model = "o4-mini"');
    expect(r.toml).toContain("notify = [");
  });

  it("inserts notify before first section header", () => {
    const r = apply('model = "o4"\n\n[features]\ngoals = true\n');
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    const notifyIdx = r.toml.indexOf("notify = [");
    const featuresIdx = r.toml.indexOf("[features]");
    expect(notifyIdx).toBeGreaterThan(-1);
    expect(featuresIdx).toBeGreaterThan(-1);
    expect(notifyIdx).toBeLessThan(featuresIdx);
  });

  it("marks changed=true on fresh empty toml", () => {
    const r = apply("");
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.changed).toBe(true);
  });

  it("removes hooks = true after migration when no structured hooks remain", () => {
    const toml = "[features]\nhooks = true\ngoals = true\n";
    const r = apply(toml);
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.toml).not.toContain("hooks = true");
    // goals = true should remain since [features] still has it
    expect(r.toml).toContain("goals = true");
  });
});

// ─── applyCodexinfoConfig — --approval-wait mode ────────────────────────────

describe("applyCodexinfoConfig --approval-wait mode", () => {
  it("installs notify + PermissionRequest, no Stop", () => {
    const r = apply("", { approvalWait: true });
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.toml).toContain("notify = [");
    expect(r.toml).toContain("[[hooks.PermissionRequest]]");
    expect(r.toml).not.toContain("[[hooks.Stop]]");
  });

  it("adds hooks = true for --approval-wait (required for structured hooks)", () => {
    const r = apply("", { approvalWait: true });
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.toml).toContain("hooks = true");
  });

  it("PermissionRequest block is wrapped in codexinfo markers", () => {
    const r = apply("", { approvalWait: true });
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.toml).toContain(CODEXINFO_MARKER_BEGIN);
    expect(r.toml).toContain(CODEXINFO_MARKER_END);
  });

  it("does not install Stop hook in --approval-wait mode", () => {
    const r = apply("", { approvalWait: true });
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.toml).not.toContain("[[hooks.Stop]]");
  });
});

// ─── applyCodexinfoConfig — migration from Phase 11/12 ──────────────────────

describe("applyCodexinfoConfig migration from stale Phase 11/12 hooks", () => {
  it("removes stale [[hooks.Stop]] block and reports hooksMigrated=true", () => {
    const stale = makeStaleToml();
    const r = apply(stale);
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.hooksMigrated).toBe(true);
    expect(r.toml).not.toContain("[[hooks.Stop]]");
    expect(r.toml).not.toContain(CODEXINFO_MARKER_BEGIN);
    expect(r.toml).toContain("notify = [");
  });

  it("removes hooks = true after migrating Stop hook (no other structured hooks)", () => {
    const stale = makeStaleToml();
    const r = apply(stale);
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.toml).not.toContain("hooks = true");
  });

  it("preserves hooks = true when other [[hooks.*]] sections remain", () => {
    const extra = "[features]\nhooks = true\n\n[[hooks.CustomEvent]]\n\n[[hooks.CustomEvent.hooks]]\ntype = \"command\"\ncommand = \"/usr/bin/other\"\n";
    const stale = extra + "\n" + [
      CODEXINFO_MARKER_BEGIN,
      "[[hooks.Stop]]",
      "",
      "[[hooks.Stop.hooks]]",
      `type    = "command"`,
      `command = "${NODE} ${HOOK}"`,
      "timeout = 30",
      CODEXINFO_MARKER_END,
      "",
    ].join("\n");
    const r = apply(stale);
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.toml).toContain("hooks = true");
    expect(r.toml).toContain("[[hooks.CustomEvent]]");
    expect(r.toml).not.toContain("[[hooks.Stop]]");
  });

  it("hooksMigrated=false when no stale Stop hook present", () => {
    const r = apply("");
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.hooksMigrated).toBe(false);
  });

  it("migrates stale Stop+PermReq and preserves notify-only result", () => {
    const stale = makeStaleToml('model = "gpt-5.4-mini"\n');
    const r = apply(stale);
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.toml).toContain('model = "gpt-5.4-mini"');
    expect(r.toml).toContain("notify = [");
    expect(r.toml).not.toContain("[[hooks.Stop]]");
    expect(r.toml).not.toContain("[[hooks.PermissionRequest]]");
  });
});

// ─── applyCodexinfoConfig — notify conflict handling ────────────────────────

describe("applyCodexinfoConfig notify conflict handling", () => {
  it("replaces ext-agent β2 notify safely (no error)", () => {
    const toml = 'notify = ["python3", "/path/to/hook_helper.py"]\n';
    const r = apply(toml);
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.toml).not.toContain("hook_helper.py");
    expect(r.toml).toContain(HOOK);
  });

  it("errors on unknown notify without --force", () => {
    const r = apply('notify = ["some-other-cmd"]\n');
    expect("error" in r).toBe(true);
  });

  it("error message names the existing notify command", () => {
    const r = apply('notify = ["some-other-cmd"]\n');
    expect("error" in r).toBe(true);
    if (!("error" in r)) return;
    expect(r.error).toContain("some-other-cmd");
  });

  it("replaces unknown notify with --force", () => {
    const r = apply('notify = ["some-other-cmd"]\n', { force: true });
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.toml).not.toContain("some-other-cmd");
    expect(r.toml).toContain(HOOK);
  });

  it("updating existing codexinfo notify is not an error (idempotent)", () => {
    const toml = `# codexinfo notify\nnotify = ["/usr/bin/node", "${HOOK}"]\n`;
    const r = apply(toml);
    expect("error" in r).toBe(false);
  });
});

// ─── applyCodexinfoConfig — idempotency ─────────────────────────────────────

describe("applyCodexinfoConfig idempotency", () => {
  it("repeated default setup produces identical output", () => {
    const first = apply("");
    expect("error" in first).toBe(false);
    if ("error" in first) return;
    const second = apply(first.toml);
    expect("error" in second).toBe(false);
    if ("error" in second) return;
    expect(second.toml).toBe(first.toml);
  });

  it("repeated --approval-wait setup produces identical output", () => {
    const first = apply("", { approvalWait: true });
    expect("error" in first).toBe(false);
    if ("error" in first) return;
    const second = apply(first.toml, { approvalWait: true });
    expect("error" in second).toBe(false);
    if ("error" in second) return;
    expect(second.toml).toBe(first.toml);
  });

  it("changed=false on second identical apply", () => {
    const first = apply('model = "o4"\n');
    expect("error" in first).toBe(false);
    if ("error" in first) return;
    const second = apply(first.toml);
    expect("error" in second).toBe(false);
    if ("error" in second) return;
    expect(second.changed).toBe(false);
  });
});

// ─── removeCodexinfoHooks ────────────────────────────────────────────────────

describe("removeCodexinfoHooks", () => {
  it("removes codexinfo notify comment and notify line", () => {
    const toml = `# codexinfo notify\nnotify = ["${NODE}", "${HOOK}"]\n`;
    const r = removeCodexinfoHooks(toml);
    expect(r).not.toContain("codexinfo-hook.js");
    expect(r).not.toContain("# codexinfo notify");
  });

  it("removes marker block (stale Stop + PermissionRequest)", () => {
    const stale = makeStaleToml();
    const r = removeCodexinfoHooks(stale);
    expect(r).not.toContain(CODEXINFO_MARKER_BEGIN);
    expect(r).not.toContain("[[hooks.Stop]]");
    expect(r).not.toContain("[[hooks.PermissionRequest]]");
  });

  it("does not remove unrelated TOML content", () => {
    const stale = makeStaleToml('model = "o4-mini"\n');
    const r = removeCodexinfoHooks(stale);
    expect(r).toContain('model = "o4-mini"');
  });

  it("removes hooks = true when no [[hooks.*]] remain", () => {
    const stale = makeStaleToml();
    const r = removeCodexinfoHooks(stale);
    expect(r).not.toContain("hooks = true");
  });

  it("preserves hooks = true when other [[hooks.*]] sections remain", () => {
    const toml =
      "[features]\nhooks = true\n[[hooks.CustomEvent]]\n\n[[hooks.CustomEvent.hooks]]\n" +
      `type = "command"\ncommand = "/usr/bin/other"\n\n# codexinfo notify\nnotify = ["${NODE}", "${HOOK}"]\n`;
    const r = removeCodexinfoHooks(toml);
    expect(r).toContain("hooks = true");
    expect(r).toContain("[[hooks.CustomEvent]]");
    expect(r).not.toContain("codexinfo-hook.js");
  });

  it("is a no-op on toml without codexinfo entries", () => {
    const toml = 'model = "o4"\n';
    const r = removeCodexinfoHooks(toml);
    expect(r).toContain('model = "o4"');
    expect(r).not.toContain("[[hooks.Stop]]");
  });

  it("removes deprecated codex_hooks = true", () => {
    const toml = "[features]\ncodex_hooks = true\n";
    const r = removeCodexinfoHooks(toml);
    expect(r).not.toContain("codex_hooks");
  });
});

// ─── parseChannels ───────────────────────────────────────────────────────────

describe("parseChannels", () => {
  it("empty array => broadcast", () => {
    const r = parseChannels([]);
    expect(r.mode).toBe("broadcast");
    expect(r.targetChannels).toEqual([]);
  });

  it("['all'] => broadcast", () => {
    const r = parseChannels(["all"]);
    expect(r.mode).toBe("broadcast");
  });

  it("specific channels => channels mode", () => {
    const r = parseChannels(["telegram"]);
    expect(r.mode).toBe("channels");
    expect(r.targetChannels).toEqual(["telegram"]);
  });

  it("multiple channels", () => {
    const r = parseChannels(["telegram", "slack"]);
    expect(r.mode).toBe("channels");
    expect(r.targetChannels).toEqual(["telegram", "slack"]);
  });

  it("mixing 'all' with specific channel throws", () => {
    expect(() => parseChannels(["all", "telegram"])).toThrow();
  });
});

// ─── meetsMinVersion ─────────────────────────────────────────────────────────

describe("meetsMinVersion", () => {
  it("exact match passes", () => {
    expect(meetsMinVersion("0.130.0", "0.130.0")).toBe(true);
  });

  it("newer patch passes", () => {
    expect(meetsMinVersion("0.130.1", "0.130.0")).toBe(true);
  });

  it("older patch fails", () => {
    expect(meetsMinVersion("0.129.9", "0.130.0")).toBe(false);
  });

  it("older minor fails", () => {
    expect(meetsMinVersion("0.129.0", "0.130.0")).toBe(false);
  });

  it("newer minor passes", () => {
    expect(meetsMinVersion("0.131.0", "0.130.0")).toBe(true);
  });

  it("newer major passes", () => {
    expect(meetsMinVersion("1.0.0", "0.130.0")).toBe(true);
  });

  it("older major fails", () => {
    expect(meetsMinVersion("0.5.0", "1.0.0")).toBe(false);
  });
});
