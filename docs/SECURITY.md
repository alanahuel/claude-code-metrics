# Security & privacy

This project is **100% local**. It reads files Claude Code already writes on
your machine, stores derived stats in a local SQLite database, and never sends
your data anywhere. There is no telemetry, no analytics, no remote server.

## What it reads

| Source | Path | Access |
| --- | --- | --- |
| Claude Code transcripts | `~/.claude/projects/**/*.jsonl` | read-only — token counts & cost are reconstructed from these |
| Live OAuth credentials | `~/.claude/.credentials.json` | **read-only**, never rewritten (Claude Code owns this file) |

Token counting from transcripts is fully offline and makes **no API calls** —
it just sums the `usage` fields Claude Code already logged.

## What it writes

| Path | Contents | Permissions |
| --- | --- | --- |
| `~/.local/share/claude-metrics/metrics.db` | SQLite history (tokens, cost, usage %) | user-only |
| `~/.local/share/claude-metrics/metrics.json` | export consumed by the dashboard | user-only |
| `~/.config/claude-usage/accounts.json` | extra-account tokens (see below) | `0600` |
| `~/.config/claude-usage/cache.json` | last usage snapshot, to avoid hammering the API | `0600` |

All of these are git-ignored and are **never** part of the repository.

## The network calls

Two things touch the network, both to Anthropic, both authenticated with the
OAuth token Claude Code already holds:

1. `GET https://api.anthropic.com/api/oauth/usage` — current limit-window
   utilization (5h / 7d / Opus). This is an **undocumented** endpoint used by
   the Claude Code client. It may change or disappear without notice; the tools
   degrade gracefully (they fall back to the last cached value) if it does.
2. `POST https://platform.claude.com/v1/oauth/token` — only used to refresh the
   token of an **extra** "stored" account you explicitly added with
   `claude-usage add NAME`. Your primary (live) account is never refreshed here.

The `CLIENT_ID` in the source is Claude Code's **public** OAuth client id, not a
secret.

> ⚠️ Using an undocumented endpoint is at your own risk and may be subject to
> Anthropic's terms. This is a personal monitoring tool, not an official product.

## Multi-account tokens

`claude-usage add NAME` snapshots the access **and refresh token** of whatever
account is currently logged into Claude Code, so it can keep showing that
account's usage after you switch back. Those tokens are stored in
`~/.config/claude-usage/accounts.json` with `0600` permissions, **in plaintext**
(same as Claude Code's own `.credentials.json`). Treat that file as a secret.
Remove an account with `claude-usage remove NAME`.

If you don't run `claude-usage add`, no tokens are ever persisted by this tool.

## The dashboard server

The optional Astro dashboard binds to `127.0.0.1:4319` (loopback only) — it is
not reachable from the network. It reads `metrics.json` locally and, if stale,
shells out to `claude-metrics export`. The zero-dependency `claude-metrics
dashboard` HTML report opens a static file and runs no server at all.

## Reporting a vulnerability

Open a private security advisory on the GitHub repository, or email the
maintainer. Please don't file public issues for sensitive reports.
