#requires -Version 5.1

param([int]$Port = 5000)

$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'YingmaCncDiscovery.ps1')

function Get-DynamicProperty {
  param($Object, [string]$Name)
  if ($null -eq $Object) { return $null }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) { return $null }
  return $property.Value
}

function Set-DynamicProperty {
  param($Object, [string]$Name, $Value)
  $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value -Force
}

function Convert-IsoOffset { param($Value); return [DateTimeOffset]::Parse([string]$Value) }
function Get-WorkDay { param([DateTimeOffset]$ObservedAt, [string]$TimeZoneId); return $ObservedAt.ToString('yyyy-MM-dd') }

function New-SnapshotBase {
  param($Machine, [string]$ObservedAt, [bool]$Connected, [string]$State, $LatencyMs, $ErrorText)
  return [pscustomobject]@{
    id = [string]$Machine.id; name = [string]$Machine.name; ip = [string]$Machine.ip
    connected = $Connected; state = $State; observedAt = $ObservedAt; currentProgram = $null
    programCount = 0; mainProgramCount = 0; completedParts = $null; totalCompletedParts = $null
    targetParts = $null; currentCycleSeconds = $null; currentCuttingSeconds = $null
    spindleRpm = $null; feedMmMin = $null; executionState = 'unknown'; workSignal = 'unavailable'
    telemetrySource = 'unavailable'; runtimeObservedAt = $null; runtimeLatencyMs = $null
    discoveryStatus = 'not_started'; discoveryConfidence = 0; discoveredServices = @()
    driver = ''; manufacturer = ''; model = ''; controller = ''; capabilities = [pscustomobject]@{}
    workDay = ''; workedTodaySeconds = 0; onlineTodaySeconds = 0; currentCycleStartedAt = $null
    error = $ErrorText
  }
}

function Assert-Equal {
  param($Actual, $Expected, [string]$Label)
  if ($Actual -ne $Expected) { throw "$Label expected '$Expected' but got '$Actual'" }
}

$machine = [pscustomobject]@{
  id = 'test-cnc'; name = 'Test CNC'; ip = '127.0.0.1'; driver = 'mtconnect'; mtConnectPort = $Port
  manufacturer = 'YINGMA'; model = 'OPEN-CNC'; controller = 'MTConnect Test'
}
$config = [pscustomobject]@{ workTimeZoneId = 'UTC'; pollSeconds = 15 }
$result = Get-CncMtConnectSnapshot $machine $config $null

Assert-Equal $result.snapshot.connected $true 'connected'
Assert-Equal $result.snapshot.currentProgram 'O1234.NC' 'program'
Assert-Equal $result.snapshot.executionState 'running' 'execution'
Assert-Equal $result.snapshot.completedParts 42 'part count'
Assert-Equal $result.snapshot.targetParts 100 'target count'
Assert-Equal $result.snapshot.currentCycleSeconds 62.5 'cycle seconds'
Assert-Equal $result.snapshot.currentCuttingSeconds 51.25 'cutting seconds'
Assert-Equal $result.snapshot.spindleRpm 8000 'spindle speed'
Assert-Equal $result.snapshot.feedMmMin 1200 'feed rate'
Assert-Equal $result.snapshot.telemetrySource 'mtconnect' 'telemetry source'

$probe = Get-CncMtConnectProbe '127.0.0.1' @($Port)
Assert-Equal $probe.manufacturer 'YINGMA' 'probe manufacturer'
Assert-Equal $probe.model 'OPEN-CNC' 'probe model'

Write-Output 'MTConnect read-only collector test passed'
