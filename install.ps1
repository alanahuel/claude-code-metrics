<#
.SYNOPSIS
  claude-code-metrics installer for Windows (PowerShell 5+).

.DESCRIPTION
  Installs the zero-dependency Python tools (claude-usage, claude-metrics),
  seeds the local SQLite history, and registers Scheduled Tasks so ingest and
  snapshot keep running every 15 minutes. Everything stays local.

.EXAMPLE
  ./install.ps1                 # core install + scheduled tasks
  ./install.ps1 -NoAutostart    # just the CLIs
  ./install.ps1 -Astro          # also build + run the optional Astro dashboard
  ./install.ps1 -Uninstall      # remove tools + tasks (keeps your data)
#>
[CmdletBinding()]
param(
  [switch]$NoAutostart,
  [switch]$Astro,
  [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'

$Repo   = Split-Path -Parent $MyInvocation.MyCommand.Path
$BinDir = Join-Path $HOME '.local\bin'
$DashDir = Join-Path $HOME '.local\share\claude-code-metrics\dashboard-astro'
$Tasks  = @('ClaudeMetrics-Ingest', 'ClaudeMetrics-Snapshot')

function Say  ($m) { Write-Host "==> $m" -ForegroundColor Green }
function Warn ($m) { Write-Host "[!] $m" -ForegroundColor Yellow }
function Die  ($m) { Write-Host "[x] $m" -ForegroundColor Red; exit 1 }

# Resolve a Python launcher (prefer the 'py' launcher, fall back to python).
function Get-Python {
  foreach ($c in @('py', 'python', 'python3')) {
    $p = Get-Command $c -ErrorAction SilentlyContinue
    if ($p) {
      $v = & $p.Source -c "import sys;print(1 if sys.version_info>=(3,8) else 0)" 2>$null
      if ($v -eq '1') { return $p.Source }
    }
  }
  return $null
}

if ($Uninstall) {
  Say "Uninstalling (your data in %USERPROFILE%\.local\share is kept)…"
  foreach ($t in $Tasks) { Unregister-ScheduledTask -TaskName $t -Confirm:$false -ErrorAction SilentlyContinue }
  Remove-Item (Join-Path $BinDir 'claude-usage'), (Join-Path $BinDir 'claude-metrics') `
              (Join-Path $BinDir 'claude-usage.cmd'), (Join-Path $BinDir 'claude-metrics.cmd') -ErrorAction SilentlyContinue
  Say "Done. To also delete your history:  Remove-Item -Recurse `"$HOME\.local\share\claude-metrics`", `"$HOME\.config\claude-usage`""
  exit 0
}

$Py = Get-Python
if (-not $Py) { Die "Python 3.8+ not found. Install it from https://python.org and re-run." }
Say "Using Python at $Py"

# ── Install the CLIs + .cmd shims ──────────────────────────────────────────
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
Copy-Item (Join-Path $Repo 'bin\claude-usage')   (Join-Path $BinDir 'claude-usage')   -Force
Copy-Item (Join-Path $Repo 'bin\claude-metrics') (Join-Path $BinDir 'claude-metrics') -Force
foreach ($tool in @('claude-usage', 'claude-metrics')) {
  $target = Join-Path $BinDir $tool
  Set-Content -Path (Join-Path $BinDir "$tool.cmd") -Encoding ASCII `
    -Value "@echo off`r`n`"$Py`" `"$target`" %*"
}
Say "Installed claude-usage and claude-metrics into $BinDir"

# Ensure BinDir is on the user PATH.
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$BinDir*") {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$BinDir", 'User')
  Warn "Added $BinDir to your user PATH. Open a new terminal for it to take effect."
}

# ── Seed the SQLite history ────────────────────────────────────────────────
Say "Building the local history database (first ingest)…"
& $Py (Join-Path $BinDir 'claude-metrics') ingest

# ── Scheduled Tasks (ingest + snapshot, every 15 min) ──────────────────────
if (-not $NoAutostart) {
  $script = Join-Path $BinDir 'claude-metrics'
  $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
             -RepetitionInterval (New-TimeSpan -Minutes 15)
  $set = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
         -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
  $map = @{ 'ClaudeMetrics-Ingest' = 'ingest'; 'ClaudeMetrics-Snapshot' = 'snapshot' }
  foreach ($t in $Tasks) {
    $action = New-ScheduledTaskAction -Execute $Py -Argument "`"$script`" $($map[$t])"
    Unregister-ScheduledTask -TaskName $t -Confirm:$false -ErrorAction SilentlyContinue
    Register-ScheduledTask -TaskName $t -Trigger $trigger -Action $action -Settings $set `
      -Description "Claude Code metrics ($($map[$t]))" | Out-Null
  }
  Say "Scheduled Tasks registered (ingest + snapshot, every 15 min)."
} else {
  Warn "Skipping autostart (-NoAutostart)."
}

# ── Optional: Astro dashboard ──────────────────────────────────────────────
if ($Astro) {
  $node = Get-Command node -ErrorAction SilentlyContinue
  $npm  = Get-Command npm  -ErrorAction SilentlyContinue
  if (-not $node -or -not $npm) {
    Warn "Node.js + npm not found; skipping the Astro dashboard."
  } else {
    Say "Building the Astro dashboard…"
    if (Test-Path $DashDir) { Remove-Item -Recurse -Force $DashDir }
    New-Item -ItemType Directory -Force -Path $DashDir | Out-Null
    Copy-Item (Join-Path $Repo 'dashboard-astro\*') $DashDir -Recurse -Force
    Push-Location $DashDir
    & $npm.Source install --no-audit --no-fund
    & $npm.Source run build
    Pop-Location
    Say "Astro dashboard built. Start it with:"
    Write-Host "    cd `"$DashDir`"; `$env:HOST='127.0.0.1'; `$env:PORT='4319'; node dist/server/entry.mjs"
  }
}

Write-Host ""
Say "Installed. Try it (in a new terminal):"
Write-Host "    claude-metrics today"
Write-Host "    claude-metrics week"
Write-Host "    claude-metrics dashboard   # opens a local HTML dashboard"
Write-Host "    claude-usage show          # live limit windows"
