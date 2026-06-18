# Windows

Run the PowerShell installer from the repo root:

```powershell
./install.ps1            # CLIs + Scheduled Tasks (ingest/snapshot every 15 min)
./install.ps1 -Astro     # also build the optional Astro dashboard
./install.ps1 -Uninstall # remove tools + tasks (keeps your data)
```

It will:

- Find a Python 3.8+ launcher (`py` / `python`).
- Copy `claude-usage` and `claude-metrics` into `%USERPROFILE%\.local\bin`, with
  `.cmd` shims so you can call them by name.
- Add that folder to your user `PATH`.
- Seed the SQLite history (`claude-metrics ingest`).
- Register two **Scheduled Tasks** (`ClaudeMetrics-Ingest`,
  `ClaudeMetrics-Snapshot`) that run every 15 minutes.

Data lives in `%USERPROFILE%\.local\share\claude-metrics\metrics.db` (the Python
script uses the same `~/.local/share` layout on every OS).

There is no waybar on Windows — use `claude-metrics dashboard` (a self-contained
HTML report) or the optional Astro dashboard at `http://127.0.0.1:4319`.

If PowerShell blocks the script, allow it for the current session:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```
