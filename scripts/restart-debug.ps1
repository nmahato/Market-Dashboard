<#
Stops any running MarketRsiDashboard node process (dev or debug) and starts a
fresh debug session (node --inspect=9229), using the same PORT and
SQLITE_DB_PATH as the "Debug Market Dashboard" VS Code launch configuration
so it doesn't touch the production database.

Usage:
  powershell -ExecutionPolicy Bypass -File scripts\restart-debug.ps1
#>

param(
    [int]$Port = 4100
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot

Write-Host "Looking for running MarketRsiDashboard node processes..."
$processes = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*server.js*" }

if ($processes) {
    foreach ($proc in $processes) {
        Write-Host "Stopping PID $($proc.ProcessId): $($proc.CommandLine)"
        Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 500
} else {
    Write-Host "No running instance found."
}

$env:PORT = $Port
$env:SQLITE_DB_PATH = Join-Path $env:TEMP "market-watch-debug.sqlite"

Write-Host "Starting in debug mode on port $Port (inspector on 9229)..."
Write-Host "DB: $($env:SQLITE_DB_PATH)"
Set-Location $projectRoot
npm run debug
