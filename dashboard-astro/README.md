# Astro dashboard (optional)

A richer, Stripe-style web dashboard for your Claude Code spend and usage. This
is **optional** — the core `claude-metrics` CLI ships a zero-dependency HTML
dashboard (`claude-metrics dashboard`) that needs no Node.js.

It reads the same local data: the Astro server reads
`~/.local/share/claude-metrics/metrics.json` (and runs `claude-metrics export`
if it is stale). It binds to **127.0.0.1:4319** only.

## Run it

```sh
# From the repo root, let the installer build + wire it up:
./install.sh --astro            # Linux/macOS
./install.ps1 -Astro            # Windows

# …or manually:
cd dashboard-astro
npm install
npm run build
HOST=127.0.0.1 PORT=4319 node dist/server/entry.mjs
# open http://127.0.0.1:4319
```

Requires Node.js 18+.

> Note: the API route resolves the `claude-metrics` CLI at
> `~/.local/bin/claude-metrics`. On Windows that path holds the Python script;
> make sure `python` can run it (the installer's `.cmd` shim handles the CLI,
> but the dashboard's auto-export step expects a directly runnable binary), or
> just run `claude-metrics export` on a schedule and let the dashboard read the
> file.
