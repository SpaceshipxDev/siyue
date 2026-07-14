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
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'uninstall.ps1') -Destination $InstallDir -Force

$config = [ordered]@{
  endpoint = $Endpoint
  token = $Token
  watcherId = 'yingma-windows-edge-01'
  pollSeconds = [Math]::Max(5, $PollSeconds)
  ftpTimeZoneId = 'UTC'
  camTimeZoneId = 'China Standard Time'
  workTimeZoneId = 'China Standard Time'
  minMainProgramBytes = 50000
  maxProgramReadBytes = 524288
  activeWindowMinutes = 5
  machines = @(
    [ordered]@{ id = 'lynuc-01'; name = 'LYNUC 01'; ip = '192.168.10.140'; runtime = [ordered]@{ port = 502; unitId = 1; verified = $false; fields = [ordered]@{} } },
    [ordered]@{ id = 'lynuc-02'; name = 'LYNUC 02'; ip = '192.168.10.141'; runtime = [ordered]@{ port = 502; unitId = 1; verified = $false; fields = [ordered]@{} } },
    [ordered]@{ id = 'lynuc-03'; name = 'LYNUC 03'; ip = '192.168.10.142'; runtime = [ordered]@{ port = 502; unitId = 1; verified = $false; fields = [ordered]@{} } }
  )
}
$config | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $InstallDir 'config.json') -Encoding UTF8

$watcherPath = Join-Path $InstallDir 'YingmaMachineWatcher.ps1'
$configPath = Join-Path $InstallDir 'config.json'
$arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$watcherPath`" -ConfigPath `"$configPath`""
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument $arguments
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew

Register-ScheduledTask `
  -TaskName $TaskName `
  -Description 'Read-only LYNUC CNC telemetry collector for yingma.siyue.ai/machines' `
  -Action $action `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Force | Out-Null

# Run one visible diagnostic cycle before starting the hidden forever task.
Write-Host 'Testing all three CNC connections...'
& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
  -NoLogo -NoProfile -ExecutionPolicy Bypass `
  -File $watcherPath -ConfigPath $configPath -TestRuntime
if ($LASTEXITCODE -ne 0) { throw 'LYNUC runtime diagnostic failed.' }
Write-Host 'Running one-time deep read-only register survey (this may take several minutes)...'
& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
  -NoLogo -NoProfile -ExecutionPolicy Bypass `
  -File $watcherPath -ConfigPath $configPath -DeepDiscoverRuntime
if ($LASTEXITCODE -ne 0) { throw 'Deep register survey failed.' }
Write-Host 'Uploading the first production snapshot...'
& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
  -NoLogo -NoProfile -ExecutionPolicy Bypass `
  -File $watcherPath -ConfigPath $configPath -Once
if ($LASTEXITCODE -ne 0) { throw 'Diagnostic cycle failed. Review the error above; the task was created but not started.' }

Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 2
$task = Get-ScheduledTask -TaskName $TaskName
Write-Host ''
Write-Host 'Yingma Machine Watcher installed successfully.' -ForegroundColor Green
Write-Host "Task:    $TaskName ($($task.State))"
Write-Host "Files:   $InstallDir"
Write-Host "Logs:    $InstallDir\logs"
Write-Host "Page:    https://yingma.siyue.ai/machines"
