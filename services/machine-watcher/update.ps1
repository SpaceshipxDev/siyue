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
$config = Join-Path $InstallDir 'config.json'
if (-not (Test-Path -LiteralPath $source)) { throw "Missing release watcher: $source" }
if (-not (Test-Path -LiteralPath $moduleSource)) { throw "Missing release discovery module: $moduleSource" }
if (-not (Test-Path -LiteralPath $config)) { throw "Existing watcher configuration not found: $config" }

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -ne $task) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }
Copy-Item -LiteralPath $source -Destination $destination -Force
Copy-Item -LiteralPath $moduleSource -Destination $moduleDestination -Force

Write-Host 'Testing LYNUC runtime connectivity...'
& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
  -NoLogo -NoProfile -ExecutionPolicy Bypass `
  -File $destination -ConfigPath $config -TestRuntime
if ($LASTEXITCODE -ne 0) { throw 'Runtime diagnostic failed; scheduled task remains stopped.' }

Write-Host 'Running one-time deep read-only register survey (this may take several minutes)...'
& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
  -NoLogo -NoProfile -ExecutionPolicy Bypass `
  -File $destination -ConfigPath $config -DeepDiscoverRuntime
if ($LASTEXITCODE -ne 0) { throw 'Deep register survey failed; scheduled task remains stopped.' }

Write-Host 'Uploading one production snapshot...'
& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
  -NoLogo -NoProfile -ExecutionPolicy Bypass `
  -File $destination -ConfigPath $config -Once
if ($LASTEXITCODE -ne 0) { throw 'Production snapshot failed; scheduled task remains stopped.' }

if ($null -ne $task) { Start-ScheduledTask -TaskName $TaskName }
Write-Host 'Yingma Machine Watcher updated successfully.' -ForegroundColor Green
