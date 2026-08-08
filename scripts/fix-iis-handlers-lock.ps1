<#
Unlocks the IIS config sections iisnode's web.config needs to override
(handlers and rewrite/rules are locked/denied at the server level by default).
Must be run from an elevated (Administrator) PowerShell prompt.
#>

$ErrorActionPreference = "Stop"
$log = Join-Path $env:TEMP "fix-iis-handlers-lock.log"
Start-Transcript -Path $log -Force | Out-Null

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "This script must be run from an elevated (Administrator) PowerShell prompt."
    Stop-Transcript | Out-Null
    exit 1
}

$appcmd = "$env:windir\system32\inetsrv\appcmd.exe"

& $appcmd unlock config -section:system.webServer/handlers
& $appcmd unlock config -section:system.webServer/rewrite/rules
& $appcmd unlock config -section:system.webServer/security/requestFiltering

Restart-WebAppPool -Name "MarketRsiDashboardPool" -ErrorAction SilentlyContinue
Stop-Website -Name "MarketRsiDashboard" -ErrorAction SilentlyContinue
Start-Website -Name "MarketRsiDashboard" -ErrorAction SilentlyContinue

Write-Host "Done. Log: $log"
Stop-Transcript | Out-Null
