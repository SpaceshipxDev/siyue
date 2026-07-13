#requires -Version 5.1
#requires -RunAsAdministrator

[CmdletBinding()]
param([switch]$RemoveData)

$TaskName = 'Yingma Machine Watcher'
$InstallDir = "$env:ProgramData\Yingma\MachineWatcher"

Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

if ($RemoveData) {
  Remove-Item -LiteralPath $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host 'Watcher, configuration, state, and logs removed.'
} else {
  Write-Host "Watcher task removed. Data retained at $InstallDir"
}
