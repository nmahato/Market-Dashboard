<#
  Deploys MarketRsiDashboard to local IIS via iisnode.
  Run this in an ELEVATED PowerShell (Run as Administrator).

  What it does:
    1. Stops any process already listening on the target port (so IIS can bind to it).
    2. Creates a dedicated IIS app pool with "No Managed Code" (required for Node apps).
    3. Creates an IIS site pointing at this project folder, bound to the target port.
    4. Grants the app pool identity write access to the data/ and iisnode/ folders
       (needed for the SQLite snapshot file and iisnode's log output).
    5. Starts the app pool and site.
#>

param(
    [string]$SiteName = "MarketRsiDashboard",
    [int]$Port = 4180,
    [string]$PhysicalPath = "c:\Personal\projects\MarketRsiDashboard"
)

$ErrorActionPreference = "Stop"

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "This script must be run as Administrator. Right-click PowerShell -> Run as administrator, then re-run this script."
    exit 1
}

Import-Module WebAdministration -ErrorAction Stop

# 1. Free up the target port if something (e.g. a manually-started `node server.js`) is bound to it.
$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listener) {
    $pids = $listener.OwningProcess | Select-Object -Unique
    foreach ($procId in $pids) {
        $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
        Write-Host "Stopping process '$($proc.ProcessName)' (PID $procId) currently listening on port $Port..."
        Stop-Process -Id $procId -Force
    }
    Start-Sleep -Seconds 1
}

# 2. App pool (No Managed Code - this is a Node app, not .NET).
if (-not (Test-Path "IIS:\AppPools\$SiteName")) {
    Write-Host "Creating app pool '$SiteName'..."
    New-WebAppPool -Name $SiteName | Out-Null
}
Set-ItemProperty "IIS:\AppPools\$SiteName" -Name managedRuntimeVersion -Value ""
Set-ItemProperty "IIS:\AppPools\$SiteName" -Name startMode -Value "AlwaysRunning"

# 3. Site.
if (Test-Path "IIS:\Sites\$SiteName") {
    Write-Host "Site '$SiteName' already exists - updating physical path and binding."
    Set-ItemProperty "IIS:\Sites\$SiteName" -Name physicalPath -Value $PhysicalPath
} else {
    Write-Host "Creating site '$SiteName' on port $Port..."
    New-Website -Name $SiteName -Port $Port -PhysicalPath $PhysicalPath -ApplicationPool $SiteName | Out-Null
}

# 4. Permissions: the app pool identity needs to read the whole app and write to data/ + iisnode/.
$identity = "IIS AppPool\$SiteName"
icacls $PhysicalPath /grant "${identity}:(OI)(CI)RX" /T | Out-Null

$dataDir = Join-Path $PhysicalPath "data"
if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir | Out-Null }
icacls $dataDir /grant "${identity}:(OI)(CI)M" /T | Out-Null

$iisnodeDir = Join-Path $PhysicalPath "iisnode"
if (-not (Test-Path $iisnodeDir)) { New-Item -ItemType Directory -Path $iisnodeDir | Out-Null }
icacls $iisnodeDir /grant "${identity}:(OI)(CI)M" /T | Out-Null

# 5. Start it up.
Start-WebAppPool -Name $SiteName -ErrorAction SilentlyContinue
Start-Website -Name $SiteName -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "Done. Dashboard should be live at http://localhost:$Port/"
Write-Host "iisnode logs (if something fails to start) land in: $iisnodeDir"
