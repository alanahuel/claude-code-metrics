# CLAUDE.md — context for Claude Code

This file orients an AI agent (Claude Code) working in this repo so it can adapt
the project to a user's machine and preferences quickly and safely.

## What this project is

Local, private usage & cost metrics for Claude Code. Two **zero-dependency
Python 3.8+** CLIs plus an optional Astro dashboard. No data leaves the machine.

- `bin/claude-usage` — live limit-window % (5h / 7d / Opus) for a status bar.
  Reads `~/.claude/.credentials.json` (read-only) and the undocumented OAuth
  usage endpoint. Caches to `~/.config/claude-usage/cache.json`.
- `bin/claude-metrics` — persistent SQLite history of tokens + API-equivalent
  cost, reconstructed offline from `~/.claude/projects/**/*.jsonl`. Generates a
  self-contained HTML dashboard and a `metrics.json` export.
- `dashboard-astro/` — optional richer web dashboard (Node, ECharts), binds to
  `127.0.0.1:4319`, reads `metrics.json`.

Data: `~/.local/share/claude-metrics/metrics.db` (SQLite, WAL). Same
`~/.local/share` / `~/.config` layout on Linux, macOS, and Windows.

## Architecture (claude-metrics)

- **Ingest** (`ingest`): full re-scan of transcripts → rebuilds `usage_hourly`
  (hour × project × model) with cost from `BASE_PRICES`. Idempotent, dedupes by
  `(message id, requestId)`. Writes `meta.last_ingest`.
- **Snapshot** (`snapshot`): captures current OAuth usage % into
  `util_snapshots` (forward-only; not reconstructable). Also recomputes the
  per-model `model_yield` (NNLS regression of % vs tokens).
- **Reports**: `today/day/week/range/models/projects/months/total/util` —
  terminal tables. `dashboard` → HTML+SVG. `report` → PDF (headless Chromium).
  `csv`/`export` → CSV / JSON.
- **Auto-bootstrap**: read commands call `_ensure_bootstrapped` (ingest if the
  DB was never ingested); `waybar`/`dashboard` call `_ingest_if_stale`.
- A background scheduler (systemd/launchd/Task Scheduler) runs ingest + snapshot
  every 15 min — see `install.sh` / `install.ps1`.

## Extension points (where to change things)

| Want to change… | Edit |
| --- | --- |
| Prices / new models | `BASE_PRICES` in `bin/claude-metrics`, or `prices` in `~/.config/claude-metrics/config.json` (then re-`ingest`). |
| Currency / symbol | `currency` in `config.json` (`{"symbol":"€","rate":0.92}`). Applied via `money()`/`money_w()` (CLI), `fmt_money` (HTML), and `CUR` in `dashboard-astro/src/scripts/dashboard.ts`. |
| Project grouping | `WORKSPACE_ROOTS` / `project_label()`, or `workspace_roots` in `config.json`. |
| Status-bar wiring | `platform/linux/waybar/`. For other bars consume `claude-*-metrics waybar` JSON (`{text,tooltip,class}`). |
| Refresh cadence | systemd `.timer` `OnUnitActiveSec`, launchd `StartInterval`, or the Scheduled Task interval in `install.ps1`. |
| Dashboard charts | `dashboard-astro/src/scripts/dashboard.ts` (ECharts) and `build_dashboard_html()` (SVG, no deps). |
| Language (UI is Spanish) | Strings are inline in `bin/claude-metrics` and the Astro `src/`. There is no i18n layer yet — translate in place. |

## Conventions & gotchas

- **Pure stdlib** for the Python CLIs — do not add pip dependencies. The config
  is JSON (not TOML) precisely to keep 3.8+ support without deps.
- Money is stored as **USD** (`cost_usd`); currency is a display-time transform
  (`× rate`). CSV export keeps raw USD on purpose.
- Cross-platform: prefer `os.path`/`pathlib`; guard OS-specific calls (see
  `_open_path`, `_notify`, `_find_chromium`). `project_label` normalizes `\`.
- The OAuth usage endpoint is **undocumented** and may break — degrade
  gracefully, never hard-fail the status bar. See `docs/SECURITY.md`.
- Never commit user data (DB, `accounts.json`, exports) — see `.gitignore`.

## Verifying changes

```sh
python3 -m py_compile bin/claude-usage bin/claude-metrics
claude-metrics today && claude-metrics models && claude-metrics config
# Astro: cd dashboard-astro && npm install && npm run build
```
