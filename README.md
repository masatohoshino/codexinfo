# CodexInfo

**Codex CLI notifications for OpenClaw** — get notified when a Codex turn completes, when Codex is waiting for your approval, and when you're approaching a rate limit.

---

## What it does

CodexInfo hooks into the Codex CLI and sends notifications through your configured OpenClaw channels (Telegram, Slack, email, etc.):

| Event | When | What you receive |
|---|---|---|
| **Completion** | Every Codex turn ends (`notify` path) | Rate-limit bars (5h and weekly windows), plus an optional one-line detail when Codex provides a final result message |
| **Approval wait** | Codex requests a tool call (automatic for VS Code; opt-in via `--approval-wait` for CLI) | Description of what Codex wants to do, plus rate-limit bars |
| **Rate-limit reached** | Any window hits 100% | Alert with affected window label and remaining bars |

Example completion notification (with detail):

```
✅ Codex complete
All 12 tests pass.
5h ███████░░░ 73% left 01:24
W  ██████░░░░ 58% left 17 May
```

Example completion notification (no detail — when Codex does not produce a final result message):

```
✅ Codex complete
5h ███████░░░ 73% left 01:24
W  ██████░░░░ 58% left 17 May
```

Example fallback when rate-limit data is unavailable:

```
✅ Codex complete
rate-limit: unavailable
```

Example approval-wait notification:

```
⏸️ Codex waiting for approval
Write file src/index.ts with updated exports
5h ███████░░░ 73% left 01:24
W  ██████░░░░ 58% left 17 May
```

---

## What it does NOT do

- Send raw prompts, AI responses, or any conversation content
- Require network access from the Codex CLI process (hook exits 0 immediately; the plugin handles delivery asynchronously)
- Support Anthropic Claude Code — CodexInfo is for OpenAI Codex CLI only
- Make approval decisions on your behalf — notifications are informational only
- Expose your OpenClaw token or bearer token in notifications

---

## Requirements

| Dependency | Minimum version |
|---|---|
| [Codex CLI](https://github.com/openai/codex) | v0.130.0 |
| [OpenClaw](https://openclaw.dev) | 2026.5.1 |
| Node.js | 20 |
| npm | 10 |

At least one OpenClaw channel (Telegram, Slack, etc.) must be configured in your gateway before CodexInfo can deliver notifications.

---

## Quick start

### 1. Install via ClawHub (recommended)

```sh
openclaw plugins install clawhub:codexinfo --dangerously-force-unsafe-install
openclaw codexinfo setup
```

**Why `--dangerously-force-unsafe-install`?** OpenClaw's plugin installer blocks code-plugins that call local shell commands until you explicitly acknowledge them. CodexInfo shells out to the local Codex CLI for version checks (`codex --version`) and rate-limit probing — both are localhost-only, no network calls. The [ClawHub scan is clean](https://github.com/masatohoshino/codexinfo) and the source code is public. The flag is OpenClaw's standard acknowledgement for community code-plugins that use `child_process`.

If you are upgrading an existing CodexInfo install, add `--force` to overwrite:
```sh
openclaw plugins install clawhub:codexinfo --dangerously-force-unsafe-install --force
```

The `setup` command is interactive. It will:
- Check that Codex CLI v0.130.0+ is installed
- Add `notify = [...]` to `~/.codex/config.toml` (no Trust review required)
- Write `~/.openclaw/codexinfo/hook-config.json` (gateway URL + bearer token)
- Write `~/.openclaw/codexinfo/config.json` (deliveries + routing)
- Write `~/.openclaw/codexinfo/manifest.json` (install record)

**No Codex `/hooks` Trust review is required.** The `notify` path works immediately after setup.

If you previously installed CodexInfo (v0.1.0–v0.1.2), re-running `setup` will automatically migrate the stale `[[hooks.Stop]]` block to the new notify path.

### 2. Configure delivery targets in the gateway

```sh
openclaw gateway config set 'plugins.entries.codexinfo.token' 'YOUR_TOKEN'
openclaw gateway config set 'plugins.entries.codexinfo.deliveries' \
  '[{"channel":"telegram","to":"YOUR_CHAT_ID"}]'
openclaw gateway restart
```

The token is printed at the end of `codexinfo setup`. Copy it before the session ends.

### 3. Verify

```sh
openclaw codexinfo doctor
```

### 4. Check notification readiness

```sh
openclaw codexinfo status --notify
```

This sends a guided status notification to your configured channel showing:
- **Completion**: whether the `notify` hook is installed
- **Rate limit**: whether the rate-limit probe is reachable
- **Approval wait**: whether `[[hooks.PermissionRequest]]` is installed and trusted (if `--approval-wait` was used)

If **Approval wait** shows `⚠️ action required`, open Codex, run `/hooks`, select PermissionRequest, and press `t` to trust.

### 5. Test

Run any Codex command. A completion notification should arrive within a few seconds.

---

## Install via npm (manual)

```sh
npm install -g codexinfo
codexinfo setup
```

When installing manually, the `codexinfo` binary is available directly (no `openclaw` prefix). The OpenClaw plugin still needs to be registered separately via `openclaw plugins install`.

## Install from tarball (pre-release)

If you have received a pre-release `.tgz` file directly:

```sh
# Install the CLI globally
npm install -g ./codexinfo-0.1.10.tgz
codexinfo setup

# Also register the OpenClaw plugin from the same tarball
openclaw plugins install --dangerously-force-unsafe-install ./codexinfo-0.1.10.tgz
openclaw gateway restart
```

Replace `0.1.10` with the version in your filename. This install path is for pre-ClawHub testing only; use `openclaw plugins install clawhub:codexinfo --dangerously-force-unsafe-install` once the package is published.

---

## Channel routing

By default, CodexInfo broadcasts to **all configured deliveries**.

Use `--channel` to restrict to specific channels:

```sh
# All channels (default)
openclaw codexinfo setup

# Telegram only
openclaw codexinfo setup --channel telegram

# Multiple specific channels
openclaw codexinfo setup --channel telegram --channel slack
```

`--channel all` is equivalent to the default (broadcast). Mixing `--channel all` with a specific channel name is an error.

To change routing after setup, re-run `openclaw codexinfo setup` (idempotent — replaces existing config).

---

## Journal

The journal records every outbound event as a JSONL file in `~/.openclaw/codexinfo-journal/`. This is useful for debugging delivery failures.

**Journal is enabled by default.**

```sh
# Disable journal during setup
openclaw codexinfo setup --no-journal

# Check journal status
openclaw codexinfo status
```

Default retention: 7 days. Journal files are rotated automatically.

Journal failures are independent of delivery failures — a journal write error never suppresses a notification.

---

## Rate-limit display

When a Codex turn completes, CodexInfo probes the Codex app-server's internal rate-limit API (local HTTP — no external network call) and attaches remaining-capacity bars to the completion notification.

Two windows are typically shown:

| Label | Meaning |
|---|---|
| `5h` | 5-hour rolling window |
| `W` | Weekly rolling window |

The bar width reflects remaining capacity. When a window hits 0%, a separate **rate-limit reached** notification is sent.

If the probe fails (Codex not running, not logged in), the notification is still sent but shows `rate-limit: unavailable` instead of bars. See [Notification shows `rate-limit: unavailable`](#notification-shows-rate-limit-unavailable) in Troubleshooting.

**Weekly reset display** can be configured:

```sh
# "12 May" style (default)
openclaw codexinfo setup

# "Tue 09:00" style
# Edit ~/.openclaw/codexinfo/config.json:
# "display": { "weeklyResetFormat": "weekday-time" }
```

---

## Approval-wait notifications

### VS Code — automatic (no Trust required)

If you use Codex through the VS Code extension, approval-wait notifications work automatically with no extra setup. When Codex requests a tool approval, CodexInfo reads the session rollout to detect the approval-wait state and sends a notification without requiring `[[hooks.PermissionRequest]]` Trust.

No additional flag is needed. Run `openclaw codexinfo setup` as usual.

### CLI — opt-in via `--approval-wait`

For the Codex CLI (terminal), approval-wait notifications are **opt-in**. To enable them, run setup with `--approval-wait`:

```sh
openclaw codexinfo setup --approval-wait
```

This installs a `[[hooks.PermissionRequest]]` hook in addition to the default `notify` path. **You must then open Codex and run `/hooks` to Trust the PermissionRequest hook.** Without Trust, Codex will show a "hooks need review" warning and the hook will not fire.

When Codex requests approval for a tool call (e.g., a Bash command or file write), CodexInfo sends an approval-wait notification immediately.

The notification description is resolved in this priority order:

1. `tool_input.description` from the hook payload (set by Codex when available)
2. Top-level `description` field (legacy/direct POST)
3. Deterministic tool category:
   - `Bash` with `curl`/`wget`/`ssh`/`scp`/network URL → `Network access requires approval.`
   - `Bash` (other) → `Bash command requires approval.`
   - `Edit`/`Write`/`apply_patch` → `File edit requires approval.`
   - `mcp__*` → `MCP tool requires approval.`
4. Generic fallback: `Codex requires approval.`

No NLP or LLM processing is performed — only the fields Codex provides are used.

**Smoke test prompt** (once `/hooks` Trust is granted):

```
Run this command once and request approval when Codex asks:
curl -I https://example.com
```

Expected notification before approving: `⏸️ Codex waiting for approval` / `Network access requires approval.`

---

## Privacy and security

- **No conversation content is transmitted.** Payloads contain: session ID, turn ID, project path (directory name only), elapsed time, tool name/description (from Codex), rate-limit window labels and percentages.
- **Completion detail lines are sanitized.** When a completion notification includes a one-line summary from Codex's final result message, the line is sanitized before delivery: code fences are replaced with `[…]`, whitespace is collapsed, known secret patterns (JWT, `sk-*`, GitHub/GitLab/npm/Slack tokens, AWS access keys, Google API keys, Telegram bot tokens, `Bearer` values) are redacted, and the result is capped at 160 characters.
- **Bearer token authentication.** The hook communicates with your local OpenClaw gateway over `http://localhost:3000` (or the URL you configure). The token is never logged or displayed after setup.
- **User-level hooks.** `~/.codex/config.toml` hooks load without repo trust — they apply to all Codex sessions regardless of project.
- **Async, non-blocking.** The hook sends a fire-and-forget HTTP POST and exits 0 immediately. It never delays or blocks Codex.
- **Rate-limit probe is local.** The probe calls the Codex app-server on localhost — no external network requests.

---

## CLI reference

### `codexinfo setup`

Configure CodexInfo. Inserts `notify = [...]` into `~/.codex/config.toml` and writes config files.

```
Options:
  --channel <name>     Target channel. Repeat for multiple. Omit for all. (default: broadcast)
  --no-journal         Disable journal
  --approval-wait      Also install PermissionRequest hook (requires /hooks Trust in Codex)
  --force              Replace an existing non-CodexInfo notify command without error
  --dry-run            Preview changes without writing
  --yes                Skip confirmation prompt
  --gateway-url <url>  OpenClaw gateway URL (default: auto-detected or http://localhost:3000).
                       Set this if your gateway runs on a non-default port (e.g. --gateway-url http://localhost:18789).
```

### `codexinfo doctor`

Read-only health check. Verifies:
- Codex CLI version (>= 0.130.0)
- `notify` path: codexinfo-hook.js is installed in `~/.codex/config.toml`
- Stale `[[hooks.Stop]]` absent (presence causes "hooks need review" in Codex v0.130.0+)
- `[[hooks.PermissionRequest]]` status (installed only with `--approval-wait`)
- Claude Code ext-agent residue in `~/.claude/settings.json` (informational)
- hook-config.json exists
- plugin config exists with token and deliveries
- Rate-limit probe reachable

```
Options:
  --notify  Send the status notification to configured delivery channels
```

### `codexinfo status`

Print current configuration summary: routing, deliveries, journal/diagnostics settings, installed version.

### `codexinfo uninstall`

Remove CodexInfo. Removes TOML hook entries, hook-config, plugin-config, and manifest. Backs up `config.toml` before editing.

```
Options:
  --yes       Skip confirmation prompt
  --dry-run   Preview what would be removed
```

---

## Troubleshooting

### Doctor shows "hook-config.json not found"

Re-run `openclaw codexinfo setup`. The config files are written during setup.

### Doctor shows "notify path: codexinfo-hook.js installed — absent"

The `notify` line is missing from `~/.codex/config.toml`. Re-run `openclaw codexinfo setup` — it will add it idempotently.

### Doctor shows "A non-CodexInfo notify command is already configured"

Another tool has already claimed the `notify` slot in `~/.codex/config.toml`. Options:
- Run `openclaw codexinfo setup --force` to replace it with CodexInfo.
- Remove the existing `notify` line manually, then re-run setup.

### Doctor shows stale `[[hooks.Stop]]`

This means you have a Phase 11/12 install. Re-run `openclaw codexinfo setup` — it migrates the stale Stop block to the notify path automatically.

### Codex shows "hooks need review"

If you see this, a `[[hooks.PermissionRequest]]` hook is installed (from `--approval-wait`) but has not been trusted yet. Open Codex and run `/hooks`, then click Trust. Alternatively, re-run `setup` without `--approval-wait` to remove the PermissionRequest hook.

### Doctor shows "rate-limit probe failed"

The Codex app-server is not reachable. Ensure Codex is running and you are logged in. The probe contacts `localhost` only — no external network required. Notifications will still be delivered but will show `rate-limit: unavailable` instead of bars.

### Notification shows `rate-limit: unavailable`

`rate-limit: unavailable` appears in completion and approval-wait notifications when the Codex app-server probe fails. Common causes:
- Codex is not currently running (no active session when the hook fires)
- Running Codex over SSH or inside Docker where the app-server is not accessible on localhost
- The probe timed out

The notification is still delivered. To see rate-limit bars, ensure Codex is running locally with a valid session. You can confirm probe reachability with `openclaw codexinfo doctor`.

### Notifications not arriving

1. Run `openclaw codexinfo doctor` — check all items are green
2. Check that the gateway is running: `openclaw gateway status`
3. Verify the token matches: compare `hook-config.json` token with gateway plugin config token
4. Check the journal: `~/.openclaw/codexinfo-journal/` — entries indicate the hook fired

### Double notifications

The VS Code Codex extension may invoke the `notify` runner more than once per logical turn. CodexInfo deduplicates before delivery using a cross-process flag cache (`~/.cache/codexinfo/dedupe/` on Linux/macOS):

- **Completion, same `turn-id`**: 10-minute TTL — atomic O_EXCL flag claim; second invocation exits silently.
- **Completion, different `turn-id` (VS Code re-fires)**: 10-second **window key** covering `client` + `cwd`. VS Code fires notify with a fresh `turn-id` per invocation; only `cwd` and `client` are stable. The first invocation claims this window; subsequent invocations within 10 seconds exit silently.
- **CLI payloads** have no `client` field — the window key is not applied, so rapid sequential CLI turns are always delivered.
- **PermissionRequest**: 2-minute TTL keyed by `turn_id + tool_use_id` (or `turn_id + tool_name + input`). A different `tool_use_id` within the same turn is **not** deduplicated — each distinct approval prompt is delivered.
- **Rollout-reclassified approval-wait (VS Code)**: 2-minute TTL keyed by `cwd`. When VS Code fires notify at `function_call` time and CodexInfo reclassifies it to approval-wait, a cwd-scoped flag prevents duplicate approval-wait notifications. The subsequent task-complete fire is NOT suppressed (different key), so the completion notification still arrives.
- **PermissionRequest + rollout-reclassification (VS Code, `--approval-wait` mode)**: When both `[[hooks.PermissionRequest]]` (structured hook) and the Path D rollout-reclassification detect the same VS Code approval request, both would otherwise generate a notification — one with the specific reason from the hook payload, one with a generic "Codex requires approval." message. The PermissionRequest path claims a shared `codexinfo:v1:approval-cwd-window:<sha256(cwd)>` flag (30-second TTL) after deciding to send. The Path D path checks this flag before firing and exits silently if claimed. Result: exactly 1 approval-wait notification with the specific PermissionRequest description. (v0.1.10)
- **Post-approval false approval-wait suppressed (VS Code)**: After a user approves a tool call, VS Code fires another `notify` event while the rollout still shows `function_call` before `function_call_output` is written. The PermissionRequest path pre-claims the rollout `raKey` flag (2-minute TTL, force-touch) so Path D is suppressed even after the 30-second cwd-window expires. Result: no spurious approval-wait notification after approval. (v0.1.10)

If you still see duplicates, check that only one CodexInfo `notify` line is present in `~/.codex/config.toml`, then run `openclaw codexinfo doctor`.

---

## ClawHub install

CodexInfo is available on ClawHub:

```sh
openclaw plugins install clawhub:codexinfo --dangerously-force-unsafe-install
```

The `--dangerously-force-unsafe-install` flag is required because OpenClaw's code scanner detects `child_process` usage. CodexInfo uses it to call `codex --version` and probe the local Codex rate-limit server — both are localhost-only calls. The ClawHub scan is clean and the source code is public.

Or with a specific version:

```sh
openclaw plugins install clawhub:codexinfo@0.1.10 --dangerously-force-unsafe-install
```

To reinstall or overwrite an existing install, add `--force`:

```sh
openclaw plugins install clawhub:codexinfo --dangerously-force-unsafe-install --force
```

After install, run `openclaw codexinfo setup` to configure.

---

## License

MIT — see [LICENSE](./LICENSE).
