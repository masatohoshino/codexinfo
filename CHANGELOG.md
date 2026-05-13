# Changelog

All notable changes to CodexInfo are documented here.

## [0.1.11] — 2026-05-13

Docs-only patch release. No runtime behavior changes.

### Documentation

- **ClawHub first-time install command** — Clarifies that the correct install command is:

  ```sh
  openclaw plugins install clawhub:codexinfo --dangerously-force-unsafe-install
  ```

  CodexInfo is a community OpenClaw code-plugin that shells out to the local Codex CLI for version checks (`codex --version`) and rate-limit probing (localhost only, no external network). OpenClaw's plugin installer requires explicit acknowledgement via `--dangerously-force-unsafe-install` for any code-plugin that uses `child_process`. The ClawHub scan is clean and the source code is public at [masatohoshino/codexinfo](https://github.com/masatohoshino/codexinfo).

  The `--force` flag is only needed when reinstalling over an existing install; omit it for a first-time install:

  ```sh
  # Reinstall / overwrite existing install
  openclaw plugins install clawhub:codexinfo --dangerously-force-unsafe-install --force
  ```

  This patch exists because ClawHub package versions are immutable: v0.1.10 was published before the install documentation was corrected, and the listing could not be updated in place.

## [0.1.10] — 2026-05-13

### Documentation

- **ClawHub install command** — The correct install command is:
  ```sh
  openclaw plugins install clawhub:codexinfo --dangerously-force-unsafe-install
  ```
  OpenClaw's code scanner requires the `--dangerously-force-unsafe-install` flag for code-plugins that call local shell commands. CodexInfo uses `child_process` to run `codex --version` (version check) and probe the local Codex rate-limit server (localhost only, no external network). The ClawHub scan for this package is clean. The `--force` flag is only needed when reinstalling over an existing install; omit it for a first-time install.

### Added

- **`CODEXINFO_HOOK_CONFIG_PATH` env var** — Overrides the default hook-config path (`~/.openclaw/codexinfo/hook-config.json`). Setting this to an empty string is treated as unset. Useful for testing with an isolated gateway without modifying the production config.

- **Optional completion detail line** — When Codex provides a final assistant/result message (`last_assistant_message` / `last-assistant-message` in the hook payload), the `✅ Codex complete` notification now includes a one-line summary derived from that message. The line is sanitized before display: code fences are replaced with `[…]`, whitespace is collapsed to a single space, known secret patterns (JWT, `sk-*`, GitHub/GitLab/npm/Slack tokens, AWS access keys, Google API keys, Telegram bot tokens, `Bearer` values) are redacted with placeholders, and the result is capped at 160 characters. When no meaningful detail is available (e.g., minimal one-liner tasks), the notification falls back to the standard format without a detail line.

  ```
  ✅ Codex complete
  All 12 tests pass.
  5h ██████████ 91% left 04:07
  W  ██████████ 95% left 19 May
  ```

### Fixed

- **VS Code approval-wait double notification** — When VS Code fires both the `[[hooks.PermissionRequest]]` structured hook and a Path D rollout-reclassification `notify` event for the same approval, both previously passed through separate dedupe namespaces (`perm:…` and `codexinfo:v1:rollout-approval:…`) and produced two Telegram messages (one with a specific reason, one with the generic "Codex requires approval."). The PermissionRequest path now writes a shared `codexinfo:v1:approval-cwd-window:<sha256(cwd)>` flag (30-second TTL) after deciding to send. Path D checks this flag before firing; if the PermissionRequest hook already claimed the slot within 30 seconds, Path D exits silently. Result: 1 approval event → 1 notification (specific reason wins).

- **VS Code false `✅ Codex complete` before `⏸️ Codex waiting for approval`** — VS Code fires the `notify` hook at `function_call` time, before Codex writes the `function_call` entry to the session rollout JSONL. The hook read an empty or pre-signal rollout, classified the event as `completion`, and sent a false completion notification ~1 s before the correct approval-wait. The rollout classifier now returns a `confirmed: boolean` field; when neither `task_complete` nor `function_call` is found, the result is `confirmed: false`. The hook retries once after 400 ms, giving the JSONL time to catch up. The classifier is also order-aware: a new `function_call` entry resets any `task_complete` seen in a prior turn, so multi-turn sessions are classified correctly.

- **VS Code post-approval false `⏸️ Codex waiting for approval`** — After a user approves a tool call, VS Code fires another `notify` event while the rollout still shows `function_call` without `function_call_output` (the approved tool has not yet produced output). This caused a spurious approval-wait notification after approval. Two fixes: (1) the retry condition now triggers on `approval-wait` results as well as unconfirmed completions, so the hook waits 400 ms for `function_call_output` to appear; (2) the `[[hooks.PermissionRequest]]` path pre-claims the rollout `raKey` flag with force-touch (2-minute TTL) so Path D is suppressed even after the 30-second cwd-window expires.

- **`doctor` rate-limit probe label** — The check label was "rate-limit probe succeeded" which displayed confusingly as `❌ rate-limit probe succeeded` when the probe failed (e.g. no Codex session running). Renamed to "rate-limit probe reachable" which reads correctly in both the passing (`✅`) and failing (`❌`) states.

- **Rate-limit unavailable fallback** — When the Codex app-server probe fails (no active session, SSH/Docker environment, or timeout), completion and approval-wait notifications now append `rate-limit: unavailable` instead of showing only the event title. This makes it clear that rate-limit data is unavailable rather than appearing as a truncated notification.

- **Journal `id` and `text` fields** — Journal JSONL entries now include `id` (8-character event identifier) and `text` (the rendered notification text), making it easier to correlate journal entries with delivered messages without re-rendering.

## [0.1.9] — 2026-05-12

### Fixed

- **Trust detection now reads `config.toml` `[hooks.state]` (Codex v0.130.0)** — The previous implementation looked for `~/.codex/trust.json` with various key shapes (`trustedCommands`, `commands`, `approved`, `trusted`), but Codex v0.130.0 never creates this file. Trust state is stored inside `config.toml` itself under `[hooks.state."<cfg>:permission_request:<n>:<m>"]` with `enabled = true` and `trusted_hash = "sha256:<hex>"`. The detector now reads `config.toml` and matches this section, so `codexinfo doctor/status` correctly shows `Approval wait: ✅ ready` after `/hooks` Trust is granted.

### Changed

- **Approval-wait Trust instructions made reproducible** — The pending-action instructions now specify: (1) Open Codex, (2) Run `/hooks`, (3) Select "PermissionRequest", (4) Press `t` to trust, (5) Confirm "Trust Trusted" is shown. Previously the instructions said only "Trust CodexInfo PermissionRequest hook" without specifying the key binding.

## [0.1.8] — 2026-05-11

### Fixed

- **Token not printed to stdout during setup** — `setup` previously interpolated the generated token value directly into the "Next steps" instructions printed to stdout. The command now shows `<paste token from ~/.openclaw/codexinfo/hook-config.json>` as a placeholder. The token is still written securely to `~/.openclaw/codexinfo/hook-config.json` and `~/.openclaw/codexinfo/config.json`.

- **Status notification title corrects for non-setup contexts** — `renderStatusNotification` previously showed "🦞 CodexInfo ready" even when there were pending actions and the context was `doctor` or `status`. It now returns "🦞 CodexInfo status" when there are pending actions in a non-setup context, and "🦞 CodexInfo setup" only when the context is `setup`.

- **`deliver-text` input validation** — Added explicit empty-body check (400 "body.text is empty") and 8192-character limit (400 "body.text exceeds 8192 character limit") to the `deliver-text` HTTP handler, in addition to the existing type check.

## [0.1.7] — 2026-05-11

### Added

- **VS Code no-Trust approval-wait (Path D)** — VS Code fires the `notify` path when it issues a `function_call` approval request. CodexInfo now reads the session rollout JSONL in `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (latest 5 files, cwd-matched, tail 4096 bytes) and reclassifies the event from `completion` to `approval-wait` when a `function_call` entry is present with no subsequent `task_complete`. This provides approval-wait notifications for VS Code users without requiring `[[hooks.PermissionRequest]]` Trust. Tool name is extracted from the rollout's `function_call.payload.name` field. Only applies when `_client` is non-empty (VS Code); CLI payloads are unaffected.

- **Guided status notifications** — `codexinfo setup` now sends a status notification after completing setup, showing the current readiness for completion, rate-limit, and approval-wait notifications. `codexinfo status --notify` and `codexinfo doctor --notify` send the same notification on demand. The notification includes Trust setup instructions when approval-wait is in `pending_action` state.

- **`deliver-text` HTTP endpoint** — `POST /plugins/codexinfo/deliver-text` accepts `{"text": "..."}` with bearer auth and delivers the text through configured channels. Used by `status --notify` and `doctor --notify`.

## [0.1.6] — 2026-05-10

### Fixed

- **`--approval-wait` setup manifest version** — `bin/codexinfo.js` wrote `version: "0.1.4"` in the install manifest; corrected to `"0.1.5"`.

### Changed

- **Network-access approval description** — When Codex requests approval for a Bash command containing a network tool (`curl`, `wget`, `ssh`, `scp`, `nc`, `ping`, `traceroute`) or an `http://`/`https://` URL, the approval-wait notification now reads "Network access requires approval." instead of the generic "Bash command requires approval." This is a deterministic keyword match on `tool_input.command` — no LLM or content summarization.

## [0.1.5] — 2026-05-10

### Fixed

- **VS Code Codex extension duplicate notifications (classification C)** — Diagnostic capture (Phase 16) confirmed that VS Code fires `notify` with completely different `turn-id`, `thread-id`, `last-assistant-message`, and `input-messages` on each invocation; only `cwd` and `client` are stable. The Phase 15 content-hash secondary key was therefore ineffective. The hook runner now uses a **window key** — `sha256("codexinfo:v1:completion:window:" + client + ":" + cwdHash)` with a 10-second mtime TTL — to coalesce VS Code re-fires within the same cwd. The window key is only applied when `client` is non-empty, so CLI payloads (no `client` field) are unaffected and rapid sequential CLI turns are not suppressed.

### Changed

- **Key namespace prefix updated** — All dedupe flag keys now use the `codexinfo:v1:` prefix (e.g., `codexinfo:v1:completion:turn:*`) to prevent stale Phase 15 flags from interfering. Existing `~/.cache/codexinfo/dedupe/` files are harmless and will be ignored (different key → different filename).
- **`CONTENT_TTL_MS` / content-hash secondary removed** — The Phase 15 content-hash key (`completion:notify:content:*`) is replaced by the window key. No behaviour change for CLI; VS Code dedup is now correct.

## [0.1.4] — 2026-05-10

### Fixed

- **VS Code Codex extension duplicate notifications** — VS Code invokes the `notify` runner twice per turn with **different `turn-id` values**, so the previous turn-id–only dedupe could not detect the duplicate. The hook runner now checks a secondary content-hash key (SHA-256 of `last-assistant-message` + `input-messages` + `cwd`, 30-second window) before the gateway POST. The first invocation claims the content key; the second finds it already set and exits silently. CLI behaviour is unchanged (CLI payloads have no `last-assistant-message` field).

### Changed

- **Dedupe cache location** — flag files moved to `$XDG_CACHE_HOME/codexinfo/dedupe` (previously `$XDG_CACHE_HOME/codexinfo/`). Existing flags are ignored; new flags are written on the next Codex turn.

## [0.1.3] — 2026-05-10

### Changed

- **Default setup now uses `notify = [...]`** instead of `[[hooks.Stop]]` — no Codex `/hooks` Trust review required; notifications work immediately after setup
- **`[[hooks.Stop]]` removed from default install** — was causing "2 hooks need review before they can run" warning in Codex v0.130.0+, which blocked all notifications
- **`[[hooks.PermissionRequest]]` is now opt-in** via `--approval-wait` flag on `setup`; requires Codex `/hooks` Trust review when used

### Added

- **Migration** — `setup` automatically removes stale Phase 11/12 `[[hooks.Stop]]` blocks on re-run and replaces them with the notify path
- **`--force` flag on `setup`** — replaces an unknown non-CodexInfo `notify` command without error (default: refuse with descriptive message)
- **notify conflict detection** — `setup` errors if a non-CodexInfo `notify` command is already configured; ext-agent β2 (`hook_helper.py`) is recognised and replaced silently
- **Argv-first payload reading** in `codexinfo-hook.js` — on the notify path Codex passes JSON in `argv[2]`, so the 3-second stdin timeout is now avoided entirely
- **Updated `doctor`** — checks notify kind (codexinfo / none / ext-agent-beta2 / unknown), stale Stop hook, PermissionRequest status, and Claude Code ext-agent residue in `~/.claude/settings.json`

## [0.1.2] — 2026-05-10

### Added

- **`CODEXINFO_DEBUG=1`** — optional stderr diagnostic log in hook runner; prints invocation event type, deduplicate key + decision (first/suppressed), and gateway HTTP status on each hook invocation

## [0.1.1] — 2026-05-10

### Fixed

- **Hook format** — removed `async = true` from Stop and PermissionRequest hooks; async hooks caused "skipping async hook" warnings on every Codex startup
- **Feature flag** — `setup` now writes `[features] hooks = true` (correct for Codex v0.130.0+) instead of deprecated `codex_hooks = true`; existing `codex_hooks = true` entries are migrated in-place on next `setup` run
- **VS Code duplicate notifications** — Stop/completion dedup TTL extended to 10 minutes (was 30 s); PermissionRequest dedup uses 2-minute TTL with per-`tool_use_id` key
- **Deduplicate cache location** — moved to `$XDG_CACHE_HOME/codexinfo` (Linux/macOS) or `%LOCALAPPDATA%/codexinfo` (Windows)
- **`uninstall`** — removes `hooks = true` from `[features]` when no other `[[hooks.*]]` sections remain
- **`detectCodexVersion`** in standalone bin now uses `shell: true` for correct PATH resolution

## [0.1.0] — 2026-05-10

Initial release.

### Added

- **Stop hook** — fires on every Codex turn completion; sends a notification with session/project info and rate-limit bars
- **PermissionRequest hook** — fires when Codex requests tool approval; sends approval-wait notification with tool description
- **Rate-limit bars** — probes the Codex app-server for current window usage and attaches remaining-capacity bars to completion notifications
- **Rate-limit-reached alert** — sends a separate notification when any rate-limit bucket hits 100%
- **Structured hooks (Codex v0.130.0+)** — uses `[[hooks.Stop]]` + `[[hooks.PermissionRequest]]` TOML hooks (stdin JSON payload, `async = true`, user-level config)
- **`codexinfo setup`** — interactive wizard; injects TOML hooks, writes hook-config and plugin-config, generates bearer token, writes install manifest; supports `--channel`, `--no-journal`, `--dry-run`, `--yes`
- **`codexinfo doctor`** — read-only health check; verifies Codex CLI version, TOML markers, hook-config, plugin-config token + deliveries, and rate-limit probe
- **`codexinfo status`** — prints current routing, deliveries, journal/diagnostics settings, and installed version from manifest
- **`codexinfo uninstall`** — removes codexinfo hooks block from `~/.codex/config.toml`, deletes hook-config, plugin-config, manifest; supports `--dry-run`, `--yes`; backs up config.toml before editing
- **Channel routing** — broadcast (default, all deliveries) or targeted (`--channel telegram`); multiple `--channel` flags supported
- **Journal** — JSONL log of all outbound events, enabled by default, 7-day retention; disable with `--no-journal`
- **Diagnostics** — optional JSONL payload-key capture for debugging; disabled by default
- **Deduplication** — completion events deduplicated per turn; prevents double-fire when VS Code fires the hook twice per turn
- **Bootstrap UX** — `bin/codexinfo.js` is a self-contained setup wizard that works before the OpenClaw plugin is installed; plain Node.js, no external dependencies
- **OpenClaw plugin** — `src/index.ts` registers the HTTP endpoint that receives hook payloads and dispatches notifications to configured channels

[0.1.0]: https://github.com/masatohoshino/codexinfo/releases/tag/v0.1.0
