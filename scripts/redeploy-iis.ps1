<#
Recycles the IIS app pool and restarts the site so it picks up the latest
code from disk. Must be run from an elevated (Administrator) PowerShell prompt.
#>

param(
    [string]$SiteName = "MarketRsiDashboard",
    [string]$AppPoolName = "MarketRsiDashboardPool"
)

$ErrorActionPreference = "Stop"
$log = Join-Path $env:TEMP "redeploy-iis.log"
Start-Transcript -Path $log -Force | Out-Null

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "This script must be run from an elevated (Administrator) PowerShell prompt."
    Stop-Transcript | Out-Null
    exit 1
}

Import-Module WebAdministration

Restart-WebAppPool -Name $AppPoolName
Stop-Website -Name $SiteName -ErrorAction SilentlyContinue
Start-Website -Name $SiteName

Write-Host "Recycled app pool '$AppPoolName' and restarted site '$SiteName'."
Stop-Transcript | Out-Null
