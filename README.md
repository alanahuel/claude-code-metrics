# claude-code-metrics

Local, private usage & cost metrics for [Claude Code](https://claude.com/claude-code) — straight from your machine, into your status bar.

Two small, **zero-dependency** Python tools:

- **`claude-usage`** — your live limit windows (**5h**, **7d**, and weekly **Opus**/Sonnet) as compact percentage bars. Great for a status bar; answers *"how close am I to my cap right now?"*
- **`claude-metrics`** — a persistent **SQLite** history of tokens and **real dollar-equivalent cost** (priced as if you paid per token at API rates), with per-hour / per-day / per-model / per-project breakdowns and a built-in HTML dashboard.

Everything is computed from files Claude Code already writes locally. **No data ever leaves your machine** — no telemetry, no account, no server (except an optional loopback-only dashboard). See [docs/SECURITY.md](docs/SECURITY.md).

> Built for a Linux + [waybar](https://github.com/Alexays/Waybar) desktop, but the data engine is pure Python and runs on **Linux, macOS, and Windows**. The status-bar widget is the Linux presentation layer; macOS/Windows users get the CLI, the HTML dashboard, and can wire the JSON into their own bar.

---

## How it works

| Signal | Source | Notes |
| --- | --- | --- |
| Tokens & cost | `~/.claude/projects/**/*.jsonl` (transcripts) | Reconstructed offline. **No API calls.** Idempotent re-scan, dedupes resumed/compacted sessions, backfills your whole history. |
| Limit usage % | `GET /api/oauth/usage` (Anthropic) | The undocumented endpoint the Claude Code client uses. Cached to avoid hammering it; degrades gracefully when offline. |

`claude-usage` reads your current % windows. `claude-metrics` keeps the long-term history: it **ingests** tokens/cost from transcripts and periodically **snapshots** the live % so you get a curve over time. A background scheduler (systemd / launchd / Task Scheduler) runs those every 15 minutes.

---

## Requirements

- **Python 3.8+** (standard library only — nothing to `pip install`)
- Claude Code, logged in (so `~/.claude/` exists)
- *Optional:* [waybar](https://github.com/Alexays/Waybar) (Linux status bar), Node.js 18+ (for the fancy Astro dashboard)

---

## Install

```sh
git clone https://github.com/alanahuel/claude-code-metrics.git
cd claude-code-metrics
```

**Linux / macOS:**

```sh
./install.sh            # installs the CLIs + background scheduler
./install.sh --waybar   # …and print the waybar wiring instructions
./install.sh --astro    # …and build + run the optional Astro dashboard
```

**Windows (PowerShell):**

```powershell
./install.ps1           # installs the CLIs + Scheduled Tasks
./install.ps1 -Astro    # …and build the optional Astro dashboard
```

The installer copies `claude-usage` and `claude-metrics` into `~/.local/bin`, seeds the SQLite database with your existing history, and sets up the 15-minute scheduler. Pass `--no-autostart` / `-NoAutostart` to skip the scheduler.

---

## Usage

```sh
claude-metrics today          # hourly spend / tokens / models for today
claude-metrics day 2026-06-10 # any date
claude-metrics week           # last 7 days
claude-metrics range A B      # daily summary between two dates
claude-metrics models [N]     # spend per model, last N days
claude-metrics projects [N]   # spend per project/folder, last N days
claude-metrics months         # month-over-month comparison
claude-metrics total          # all-time tokens & cost
claude-metrics dashboard      # generate + open the HTML dashboard
claude-metrics report [f.pdf] [--days N|--all|--from D --to D] [--project P]  # ranged PDF report
claude-metrics csv [f.csv]    # export hourly detail for a spreadsheet
claude-metrics config         # show/create the config file
claude-metrics ingest         # rebuild history now
claude-metrics snapshot       # capture current usage % now

claude-usage show             # readable 5h / 7d / Opus breakdown
claude-usage notify           # desktop notification with the breakdown
claude-usage add NAME         # track an extra account (see SECURITY.md)
claude-usage list | remove NAME
```

Both tools also accept a `waybar` subcommand that prints JSON for a status bar.

### Pricing

`claude-metrics` estimates cost from a price table (USD per million tokens, with the standard cache multipliers). This is a *what-if API cost* estimate — your subscription may bill differently. Override prices either in `BASE_PRICES` (top of `bin/claude-metrics`) or in the config file below, then re-run `claude-metrics ingest`.

### Configuration

Optional `~/.config/claude-metrics/config.json` (run `claude-metrics config` to create a template):

```jsonc
{
  "currency": { "symbol": "€", "rate": 0.92 },        // displayed as USD × rate
  "prices":   { "claude-new-model-1": [5.0, 25.0] },   // USD per million [in, out]
  "workspace_roots": ["work", "code"]                  // folders skipped when naming projects
}
```

### Make it yours

Open this repo in **Claude Code** — it reads [`CLAUDE.md`](CLAUDE.md) and can adapt the tool to your machine (currency, language, a different status bar, extra charts, budget alerts). See [docs/CUSTOMIZE.md](docs/CUSTOMIZE.md) for copy-paste prompts.

---

## waybar (Linux)

Copy the two module blocks from [`platform/linux/waybar/config.snippet.jsonc`](platform/linux/waybar/config.snippet.jsonc) into your `~/.config/waybar/config.jsonc`, add `"custom/claude"` and/or `"custom/claude-metrics"` to a `modules-*` array, optionally append [`style.snippet.css`](platform/linux/waybar/style.snippet.css) to your `style.css`, then reload:

```sh
killall -SIGUSR2 waybar
```

- **`custom/claude`** → the live % bars; click for a notification.
- **`custom/claude-metrics`** → today/month spend; click opens the dashboard.

## Other platforms / other bars

The `waybar` JSON output (`{"text", "tooltip", "class"}`) is generic. To put it elsewhere:

- **macOS:** feed `claude-metrics waybar` / `claude-usage waybar` into [SketchyBar](https://github.com/FelixKratz/SketchyBar) or [xbar](https://xbarapp.com/), or just use `claude-metrics dashboard`.
- **Windows:** use the HTML/Astro dashboard, or pipe the CLI output into a custom widget.
- Anywhere: `claude-metrics today` / `claude-usage show` in a terminal works on all three OSes.

---

## Optional Astro dashboard

A richer Stripe-style web dashboard lives in [`dashboard-astro/`](dashboard-astro/) and binds to `127.0.0.1:4319` (loopback only). It's optional and needs Node.js — the built-in `claude-metrics dashboard` HTML report needs nothing extra. See [dashboard-astro/README.md](dashboard-astro/README.md).

---

## Uninstall

```sh
./install.sh --uninstall      # Linux/macOS — removes tools + scheduler, keeps data
./install.ps1 -Uninstall      # Windows
```

Your history (`~/.local/share/claude-metrics`) and config (`~/.config/claude-usage`) are kept; the command prints how to delete them too.

---

## Disclaimer

Not affiliated with Anthropic. It relies on an **undocumented** OAuth usage endpoint that may change or break at any time, and on the on-disk transcript format — both used by Claude Code itself. Cost figures are estimates. Use at your own risk. MIT licensed.
