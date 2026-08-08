<#
Deploys MarketRsiDashboard to local IIS via iisnode.
Must be run from an elevated (Administrator) PowerShell prompt.

Usage:
  powershell -ExecutionPolicy Bypass -File scripts\deploy-iis.ps1
#>

param(
    [string]$SiteName = "MarketRsiDashboard",
    [string]$AppPoolName = "MarketRsiDashboardPool",
    [int]$Port = 8080
)

$ErrorActionPreference = "Stop"

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "This script must be run from an elevated (Administrator) PowerShell prompt."
    exit 1
}

$projectRoot = Split-Path -Parent $PSScriptRoot
Write-Host "Project root: $projectRoot"

# 1. Install iisnode if missing
$iisnodeDll = "C:\Program Files\iisnode\iisnode.dll"
if (-not (Test-Path $iisnodeDll)) {
    Write-Host "iisnode not found. Downloading and installing..."
    $msiUrl = "https://github.com/Azure/iisnode/releases/download/v0.2.26/iisnode-core-v0.2.26-x64.msi"
    $msiPath = Join-Path $env:TEMP "iisnode-core-v0.2.26-x64.msi"
    Invoke-WebRequest -Uri $msiUrl -OutFile $msiPath -UseBasicParsing
    $proc = Start-Process msiexec.exe -ArgumentList "/i `"$msiPath`" /qn /norestart" -Wait -PassThru
    if ($proc.ExitCode -ne 0) {
        Write-Error "iisnode installation failed with exit code $($proc.ExitCode)."
        exit 1
    }
    Write-Host "iisnode installed."
} else {
    Write-Host "iisnode already installed."
}

# 2. Load IIS management module
Import-Module WebAdministration

# 3. Create app pool (No Managed Code, since this is a plain Node app)
if (-not (Test-Path "IIS:\AppPools\$AppPoolName")) {
    New-WebAppPool -Name $AppPoolName | Out-Null
    Write-Host "Created app pool '$AppPoolName'."
}
Set-ItemProperty "IIS:\AppPools\$AppPoolName" -Name managedRuntimeVersion -Value ""
Set-ItemProperty "IIS:\AppPools\$AppPoolName" -Name processModel.identityType -Value ApplicationPoolIdentity

# 4. Create the site
if (Get-Website -Name $SiteName -ErrorAction SilentlyContinue) {
    Write-Host "Site '$SiteName' already exists, updating physical path and binding."
    Set-ItemProperty "IIS:\Sites\$SiteName" -Name physicalPath -Value $projectRoot
} else {
    New-Website -Name $SiteName -PhysicalPath $projectRoot -ApplicationPool $AppPoolName -Port $Port -HostHeader "" | Out-Null
    Write-Host "Created site '$SiteName' bound to localhost:$Port."
}

# 5. Grant the app pool identity permission to read/write the project folder
# (needed so iisnode can write its log folder and the app can write to data/*.sqlite)
$acct = "IIS AppPool\$AppPoolName"
icacls $projectRoot /grant "${acct}:(OI)(CI)M" /T | Out-Null
Write-Host "Granted '$acct' modify rights on $projectRoot."

# 6. Start pool/site
Start-WebAppPool -Name $AppPoolName -ErrorAction SilentlyContinue
Start-Website -Name $SiteName -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "Done. Browse to http://localhost:$Port"
Write-Host "iisnode logs (if enabled) will appear under $projectRoot\iisnode\"
