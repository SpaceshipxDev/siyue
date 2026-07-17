#requires -Version 5.1

[CmdletBinding()]
param(
  [string]$InstallDir = "$env:ProgramData\Yingma\MachineWatcher"
)

$ErrorActionPreference = 'Stop'
$TaskName = 'Yingma Machine Watcher'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this updater from Windows PowerShell as Administrator.'
}

$source = Join-Path $PSScriptRoot 'YingmaMachineWatcher.ps1'
$destination = Join-Path $InstallDir 'YingmaMachineWatcher.ps1'
$moduleSource = Join-Path $PSScriptRoot 'YingmaCncDiscovery.ps1'
$moduleDestination = Join-Path $InstallDir 'YingmaCncDiscovery.ps1'
$vendorSource = Join-Path $PSScriptRoot 'YingmaVendorDrivers.ps1'
$vendorDestination = Join-Path $InstallDir 'YingmaVendorDrivers.ps1'
$config = Join-Path $InstallDir 'config.json'
$collectorPowerShell = "$env:SystemRoot\SysWOW64\WindowsPowerShell\v1.0\powershell.exe"
if (-not (Test-Path -LiteralPath $collectorPowerShell)) { throw '32-bit Windows PowerShell is required for the Mitsubishi EZSocket runtime.' }
if (-not (Test-Path -LiteralPath $source)) { throw "Missing release watcher: $source" }
if (-not (Test-Path -LiteralPath $moduleSource)) { throw "Missing release discovery module: $moduleSource" }
if (-not (Test-Path -LiteralPath $vendorSource)) { throw "Missing release vendor module: $vendorSource" }
if (-not (Test-Path -LiteralPath $config)) { throw "Existing watcher configuration not found: $config" }

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -ne $task) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }
Copy-Item -LiteralPath $source -Destination $destination -Force
Copy-Item -LiteralPath $moduleSource -Destination $moduleDestination -Force
Copy-Item -LiteralPath $vendorSource -Destination $vendorDestination -Force

Write-Host 'Testing configured controller runtimes and read access...'
& $collectorPowerShell `
  -NoLogo -NoProfile -ExecutionPolicy Bypass `
  -File $destination -ConfigPath $config -TestVendor
if ($LASTEXITCODE -ne 0) {
  Write-Warning 'One or more optional controller fields are not readable yet. The updated collector will still run and will retry them automatically.'
}

Write-Host 'Discovering and saving every high-confidence CNC endpoint on the connected subnets...'
& $collectorPowerShell `
  -NoLogo -NoProfile -ExecutionPolicy Bypass `
  -File $destination -ConfigPath $config -AdoptDiscovery
if ($LASTEXITCODE -ne 0) { throw 'CNC network discovery failed; scheduled task remains stopped.' }

Write-Host 'Uploading one production snapshot...'
& $collectorPowerShell `
  -NoLogo -NoProfile -ExecutionPolicy Bypass `
  -File $destination -ConfigPath $config -Once
if ($LASTEXITCODE -ne 0) { throw 'Production snapshot failed; scheduled task remains stopped.' }

if ($null -ne $task) { Start-ScheduledTask -TaskName $TaskName }
Write-Host 'Yingma Machine Watcher updated successfully.' -ForegroundColor Green
