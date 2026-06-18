# Customize it (with your own Claude Code)

This tool is built for Claude Code users — so the easiest way to adapt it to
your machine is to **ask your own Claude Code to do it**. Open this repo in
Claude Code (it reads [`CLAUDE.md`](../CLAUDE.md) automatically) and paste any of
the prompts below. Most changes need no code at all — just the config file.

## The config file (no code)

`~/.config/claude-metrics/config.json` — create it with:

```sh
claude-metrics config        # creates a template and prints the path
```

```jsonc
{
  "currency": { "symbol": "€", "rate": 0.92 },   // shown as USD × rate
  "prices":   { "claude-new-model-1": [5.0, 25.0] }, // USD per million [in, out]
  "workspace_roots": ["work", "code"]            // folders skipped when naming projects
}
```

After changing `prices`, run `claude-metrics ingest` to recompute history.

## Copy-paste prompts for your Claude Code

**Currency**
> Set my currency to euros at today's rate in `~/.config/claude-metrics/config.json`.

**A new or repriced model**
> Add `claude-<model>` to my pricing at $X in / $Y out per million tokens and re-ingest.

**Translate the UI** (it ships in Spanish)
> Translate the `claude-metrics` terminal reports and the Astro dashboard UI strings to English.

**Wire it into a different status bar**
> I use <Polybar / SketchyBar / xbar / GNOME / KDE>. Wire `claude-metrics waybar`
> and `claude-usage waybar` JSON (`{text,tooltip,class}`) into it. Update it every
> ~2 min and make a click open `claude-metrics dashboard`.

**Change how often it refreshes**
> Make the ingest/snapshot scheduler run every 5 minutes instead of 15.

**Add a chart or KPI**
> Add a "cost per message" KPI to the Astro dashboard and a 14-day moving-average
> line to the spend chart. Keep the existing design system.

**Budget alert**
> Send me a desktop notification when this month's spend crosses €100, checked hourly.

**Export automatically**
> Schedule a monthly PDF report (`claude-metrics report ~/Reports/claude-$(date +%Y-%m).pdf`).

## Per-OS adaptation

The data engine is identical on Linux/macOS/Windows; only the *presentation*
differs. If something status-bar-specific doesn't fit your setup, ask your
Claude Code: *"adapt the autostart/status-bar integration for my OS and bar"* —
point it at `platform/` and `install.{sh,ps1}`.

## Exports & reports

```sh
claude-metrics report                 # PDF to ~/.local/share/claude-metrics/
claude-metrics report ~/spend.pdf     # PDF to a path you choose
claude-metrics csv ~/spend.csv        # hourly detail for a spreadsheet
claude-metrics export                 # metrics.json (feeds the Astro dashboard)
```

`report` uses a headless Chromium/Chrome/Brave/Edge if present; otherwise it
opens the HTML so you can "Print → Save as PDF".
