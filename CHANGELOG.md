# Changelog

All notable changes to this project will be documented in this file.

## [1.8.4] - 2026-06-12

### Fixed

- **`sync` group history: all groups erroring (20/20 errors)** — root cause was two bugs: (1) the DM HTTP per-friend endpoint (`/api/message/history`) returns 404 for every friend, causing 1341 wasted requests that strained the Zalo session before group fetches began; (2) the WebSocket DM listener was started before group HTTP calls, further contaminating the session. Fix: removed the dead DM HTTP code, and moved group HTTP fetches to run **before** the DM WebSocket session. DM history (self-sent messages) still syncs via WebSocket after all group HTTP calls complete.

## [1.8.3] - 2026-06-12

### Changed

- **`sync` group history now logs per-group progress** — every 20 groups it prints `[X/total] N with messages, M errors` so you can see the sync is running and how many groups have accessible history. Also adds per-group breakdown (`with_messages`, `empty`, `errors`) to `--json` output.

## [1.8.2] - 2026-06-12

### Changed

- **`sync --delay` default raised from 200ms to 2000ms** — more conservative default to reliably avoid Zalo rate limiting across all group history fetches.

## [1.8.1] - 2026-06-12

### Added

- **`sync --delay <ms>` option** — configurable delay between group history requests (default 200ms). Use a higher value (e.g. `--delay 500`) if groups are still being skipped, or lower (e.g. `--delay 50`) for faster syncs on accounts that aren't being throttled.

## [1.8.0] - 2026-06-12

### Fixed

- **`sync` group history only fetched ~5 groups** — rapid sequential `getGroupChatHistory` calls caused Zalo to rate-limit most requests silently. Added 200ms delay between group fetches to stay within rate limits. With 360 groups and `--per-thread 20`, this adds ~72s but reliably fetches all groups.

## [1.7.9] - 2026-06-12

### Changed

- **`sync` `--msg-limit` replaced with `--per-thread <n>` (default 50)** — old global cap caused only ~49 messages to sync across 360 groups. New option fetches up to N recent messages per group and per DM thread independently, with no global ceiling.

## [1.7.8] - 2026-06-12

### Fixed

- **Update checker pointed at wrong package name** — was querying `zalo-agent-cli` (old name, latest 1.6.2) instead of `@realtimex/zalo-cli`, causing a spurious "downgrade available" warning. Both `checkForUpdates` and `selfUpdate` now use the correct scoped package name.

## [1.7.7] - 2026-06-12

### Fixed

- **`sync` command only synced self-sent messages** — the Zalo WebSocket global feed (`requestOldMessages`) only returns messages authored by the current user; received messages were silently excluded. Group sync now uses `getGroupChatHistory` per group via HTTP, which returns all messages (sent + received). DM sync attempts a per-friend HTTP history fetch first and falls back to the WebSocket feed if the endpoint is unavailable.

## [1.6.1] - 2026-03-27

### Security

- **HTTP MCP binds to `127.0.0.1` by default** — prevents accidental network exposure of Zalo sessions. Use `--host 0.0.0.0` to override.
- **Command injection fix** — replaced `exec()` with `execFile()` in media file opener, preventing shell injection via crafted filenames.
- **Timing-safe token comparison** — bearer token auth now uses `crypto.timingSafeEqual` instead of `===`, resistant to timing attacks.
- **Empty `--auth` validation** — `--auth ""` no longer silently disables authentication middleware.

### Added

- `--host <address>` flag for MCP HTTP transport to control bind address.
- `prepublishOnly` script — blocks `npm publish` if lint or tests fail.
- `npm test` step in CI workflow — tests now run on every push/PR.
- `getThreadType()` public method on `MessageBuffer` (replaces private `_threads` access).
- Port validation for `--http` flag (rejects non-integer or out-of-range values).
- Unit tests for `getThreadType()` (4 new tests, total: 145).

### Fixed

- Webhook fetch timeout — added `AbortSignal.timeout(5000)` to prevent connection leaks on slow webhook servers.
- Silent `catch {}` blocks in listen command replaced with `console.error` for debuggability.
- Graceful shutdown in MCP mode — SIGINT now stops Zalo listener, flushes notifier, and closes HTTP server.
- Windows compatibility — `openFile()` now handles `start` (cmd.exe builtin) correctly with `shell: true`.

### Changed

- MCP server version now reads from `package.json` instead of hardcoded `"1.0.0"` (both stdio and HTTP transports).
- `mcp-tools.js` uses `buffer.getThreadType()` public API instead of accessing `buffer._threads` directly.

## [1.6.0] - 2026-03-26

### Added

- MCP server for AI agent integration (stdio + HTTP transports)
- Unified media downloader with auto-download and organized folder structure
- Thread name cache with Vietnamese accent-insensitive search
- Notifier system for offline agent alerts
- Thread filter with glob pattern matching

## [1.5.1] - 2026-03-25

### Fixed

- Minor bug fixes and stability improvements
