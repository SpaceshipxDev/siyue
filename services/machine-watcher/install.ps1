#requires -Version 5.1
#requires -RunAsAdministrator

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Token,
  [string]$Endpoint = 'https://yingma.siyue.ai/api/machines/ingest',
  [string]$InstallDir = "$env:ProgramData\Yingma\MachineWatcher",
  [int]$PollSeconds = 15
)

$ErrorActionPreference = 'Stop'
$TaskName = 'Yingma Machine Watcher'

if ($Token.Length -lt 24) { throw 'The ingest token is missing or too short.' }
if ($Endpoint -notmatch '^https://') { throw 'Endpoint must use HTTPS.' }

New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $InstallDir 'logs') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'YingmaMachineWatcher.ps1') -Destination $InstallDir -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'YingmaCncDiscovery.ps1') -Destination $InstallDir -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'YingmaVendorDrivers.ps1') -Destination $InstallDir -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'uninstall.ps1') -Destination $InstallDir -Force

$addresses = 81..95 | ForEach-Object { "192.168.10.$_" }
$machines = 81..95 | ForEach-Object {
  [ordered]@{ id = "cnc-$_"; name = "CNC $_"; ip = "192.168.10.$_"; driver = 'auto' }
}

$config = [ordered]@{
  endpoint = $Endpoint
  token = $Token
  watcherId = 'yingma-windows-edge-01'
  pollSeconds = [Math]::Max(5, $PollSeconds)
  uploadTimeoutSeconds = 120
  ftpTimeZoneId = 'UTC'
  camTimeZoneId = 'China Standard Time'
  workTimeZoneId = 'China Standard Time'
  minMainProgramBytes = 50000
  maxProgramReadBytes = 2097152
  maxProgramSourceBytes = 2097152
  activeWindowMinutes = 5
  discovery = [ordered]@{ enabled = $true; addresses = @($addresses); subnets = @(); ports = @(21, 502, 683, 8193); maxHosts = 64 }
  machines = @($machines)
}
$config | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $InstallDir 'config.json') -Encoding UTF8

$watcherPath = Join-Path $InstallDir 'YingmaMachineWatcher.ps1'
$configPath = Join-Path $InstallDir 'config.json'
$collectorPowerShell = "$env:SystemRoot\SysWOW64\WindowsPowerShell\v1.0\powershell.exe"
if (-not (Test-Path -LiteralPath $collectorPowerShell)) {
  throw '32-bit Windows PowerShell is required because the official Mitsubishi EZSocket automation runtime is 32-bit.'
}
$arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$watcherPath`" -ConfigPath `"$configPath`""
$action = New-ScheduledTaskAction -Execute $collectorPowerShell -Argument $arguments
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
# Perform one complete visible collection. It reports every readable field and
# queues the batch durably before the forever task is registered.
Write-Host 'Reading all configured CNCs and uploading the first production snapshot...'
& $collectorPowerShell `
  -NoLogo -NoProfile -ExecutionPolicy Bypass `
  -File $watcherPath -ConfigPath $configPath -Once
if ($LASTEXITCODE -ne 0) {
  Write-Warning 'The first cloud upload failed, but the payload is safely queued. The persistent task will install and retry automatically every minute.'
}

$settings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew

Register-ScheduledTask `
  -TaskName $TaskName `
  -Description 'Read-only FANUC, Mitsubishi, and LYNUC telemetry collector for yingma.siyue.ai/machines' `
  -Action $action `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 2
$task = Get-ScheduledTask -TaskName $TaskName
Write-Host ''
Write-Host 'Yingma Machine Watcher installed successfully.' -ForegroundColor Green
Write-Host "Task:    $TaskName ($($task.State))"
Write-Host "Files:   $InstallDir"
Write-Host "Logs:    $InstallDir\logs"
Write-Host "Page:    https://yingma.siyue.ai/machines"
Write-Host "Details: https://yingma.siyue.ai/machines/dev"
