#requires -Version 5.1

[CmdletBinding()]
param(
  [string]$ConfigPath = (Join-Path $PSScriptRoot 'config.json'),
  [switch]$Once
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$WatcherVersion = '1.1.0'
$DataRoot = Split-Path -Parent $ConfigPath
$LogDir = Join-Path $DataRoot 'logs'
$StatePath = Join-Path $DataRoot 'state.json'
$PendingPath = Join-Path $DataRoot 'pending.json'
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null

function Write-WatcherLog {
  param([string]$Message, [ValidateSet('INFO', 'WARN', 'ERROR')][string]$Level = 'INFO')
  $line = '{0:u} [{1}] {2}' -f [DateTime]::UtcNow, $Level, $Message
  $path = Join-Path $LogDir ('watcher-{0}.log' -f (Get-Date -Format 'yyyy-MM-dd'))
  Add-Content -LiteralPath $path -Value $line -Encoding UTF8
  if ($Once -or $Host.Name -ne 'Default Host') { Write-Host $line }
  Get-ChildItem -LiteralPath $LogDir -Filter 'watcher-*.log' -File -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTimeUtc -lt [DateTime]::UtcNow.AddDays(-14) } |
    Remove-Item -Force -ErrorAction SilentlyContinue
}

function Read-JsonFile {
  param([string]$Path, $Fallback)
  if (-not (Test-Path -LiteralPath $Path)) { return $Fallback }
  try { return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json }
  catch { Write-WatcherLog "Cannot read ${Path}: $($_.Exception.Message)" 'WARN'; return $Fallback }
}

function Write-JsonAtomic {
  param([string]$Path, $Value, [int]$Depth = 12)
  $temp = "$Path.tmp"
  $Value | ConvertTo-Json -Depth $Depth | Set-Content -LiteralPath $temp -Encoding UTF8
  Move-Item -LiteralPath $temp -Destination $Path -Force
}

function Get-DynamicProperty {
  param($Object, [string]$Name)
  if ($null -eq $Object) { return $null }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) { return $null }
  return $property.Value
}

function Set-DynamicProperty {
  param($Object, [string]$Name, $Value)
  if ($null -eq $Object) { return }
  $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value -Force
}

function Convert-IsoOffset {
  param($Value)
  if ($Value -is [DateTimeOffset]) { return [DateTimeOffset]$Value }
  if ($Value -is [DateTime]) {
    $date = [DateTime]$Value
    if ($date.Kind -eq [DateTimeKind]::Unspecified) { $date = [DateTime]::SpecifyKind($date, [DateTimeKind]::Utc) }
    return [DateTimeOffset]$date
  }
  return [DateTimeOffset]::ParseExact(
    [string]$Value,
    'o',
    [Globalization.CultureInfo]::InvariantCulture,
    [Globalization.DateTimeStyles]::RoundtripKind
  )
}

function Read-ExactBytes {
  param([IO.Stream]$Stream, [int]$Count)
  $buffer = New-Object byte[] $Count
  $offset = 0
  while ($offset -lt $Count) {
    $read = $Stream.Read($buffer, $offset, $Count - $offset)
    if ($read -le 0) { throw 'The controller closed the Modbus connection' }
    $offset += $read
  }
  return $buffer
}

function Get-ModbusRunSignal {
  param([string]$HostName, $Signal)
  $client = New-Object Net.Sockets.TcpClient
  try {
    $port = if (Get-DynamicProperty $Signal 'port') { [int]$Signal.port } else { 502 }
    $pending = $client.BeginConnect($HostName, $port, $null, $null)
    if (-not $pending.AsyncWaitHandle.WaitOne(2000)) { throw 'Modbus connection timed out' }
    $client.EndConnect($pending)
    $stream = $client.GetStream()
    $stream.ReadTimeout = 2000
    $stream.WriteTimeout = 2000

    $unit = if (Get-DynamicProperty $Signal 'unitId') { [int]$Signal.unitId } else { 1 }
    $address = [int]$Signal.address
    [byte[]]$request = @(
      0x59, 0x4d, 0x00, 0x00, 0x00, 0x06,
      ($unit -band 0xff), 0x03,
      (($address -shr 8) -band 0xff), ($address -band 0xff),
      0x00, 0x01
    )
    $stream.Write($request, 0, $request.Length)
    $header = Read-ExactBytes $stream 7
    $length = ([int]$header[4] -shl 8) -bor [int]$header[5]
    if ($length -lt 3 -or $length -gt 260) { throw 'Invalid Modbus response length' }
    $body = Read-ExactBytes $stream ($length - 1)
    if (($body[0] -band 0x80) -ne 0) { throw "Modbus exception $($body[1])" }
    if ($body[0] -ne 3 -or $body[1] -lt 2) { throw 'Unexpected Modbus response' }
    $value = ([int]$body[2] -shl 8) -bor [int]$body[3]
    $mask = if (Get-DynamicProperty $Signal 'bitMask') { [int]$Signal.bitMask } else { 65535 }
    $activeValue = if ($null -ne (Get-DynamicProperty $Signal 'activeValue')) { [int]$Signal.activeValue } else { 1 }
    return [pscustomobject]@{ available = $true; active = (($value -band $mask) -eq $activeValue); value = $value; error = $null }
  } catch {
    return [pscustomobject]@{ available = $false; active = $false; value = $null; error = $_.Exception.Message }
  } finally {
    $client.Dispose()
  }
}

function Get-WorkDay {
  param([DateTimeOffset]$ObservedAt, [string]$TimeZoneId)
  $zone = [TimeZoneInfo]::FindSystemTimeZoneById($TimeZoneId)
  return [TimeZoneInfo]::ConvertTime($ObservedAt, $zone).ToString('yyyy-MM-dd')
}

function Update-DailyTelemetry {
  param($Machine, $Config, $Previous, $Snapshot, $State)
  $observed = Convert-IsoOffset $Snapshot.observedAt
  $day = Get-WorkDay $observed ([string]$Config.workTimeZoneId)
  $executionState = 'unknown'
  $workSignal = 'unavailable'
  $workActive = $false

  $runSignal = Get-DynamicProperty $Machine 'runSignal'
  if ($Snapshot.connected -and $null -ne $runSignal) {
    $signal = Get-ModbusRunSignal ([string]$Machine.ip) $runSignal
    if ($signal.available) {
      $workSignal = 'controller_cycle'
      $workActive = [bool]$signal.active
      $executionState = if ($workActive) { 'running' } else { 'stopped' }
    }
  }
  if ($Snapshot.connected -and $workSignal -eq 'unavailable' -and $Snapshot.state -eq 'programming') {
    # Conservative fallback: this proves the machine's NC program is changing,
    # but it is not presented as an actual CycleStart signal in the UI.
    $workSignal = 'program_activity'
    $workActive = $true
  }

  $worked = 0
  $online = 0
  $previousDay = [string](Get-DynamicProperty $Previous 'workDay')
  if ($previousDay -eq $day) {
    $oldWorked = Get-DynamicProperty $Previous 'workedTodaySeconds'
    $oldOnline = Get-DynamicProperty $Previous 'onlineTodaySeconds'
    if ($null -ne $oldWorked) { $worked = [int]$oldWorked }
    if ($null -ne $oldOnline) { $online = [int]$oldOnline }

    $previousObservedRaw = Get-DynamicProperty $Previous 'observedAt'
    if ($previousObservedRaw) {
      $delta = [int][Math]::Floor(($observed - (Convert-IsoOffset $previousObservedRaw)).TotalSeconds)
      $maxDelta = [Math]::Max(60, [int]$Config.pollSeconds * 3)
      if ($delta -gt 0 -and $delta -le $maxDelta) {
        if ([bool](Get-DynamicProperty $Previous 'connected') -and $Snapshot.connected) { $online += $delta }
        if ([bool](Get-DynamicProperty $Previous 'workActive') -and $workActive) { $worked += $delta }
      }
    }
  }

  $cycleStarted = $null
  if ($workSignal -eq 'controller_cycle' -and $workActive) {
    $wasRunning = [bool](Get-DynamicProperty $Previous 'workActive') -and
      ([string](Get-DynamicProperty $Previous 'workSignal') -eq 'controller_cycle')
    $storedStart = Get-DynamicProperty $Previous 'currentCycleStartedAt'
    $cycleStarted = if ($wasRunning -and $storedStart) { (Convert-IsoOffset $storedStart).ToString('o') } else { $observed.ToString('o') }
  }

  $Snapshot.executionState = $executionState
  $Snapshot.workSignal = $workSignal
  $Snapshot.workDay = $day
  $Snapshot.workedTodaySeconds = $worked
  $Snapshot.onlineTodaySeconds = $online
  $Snapshot.currentCycleStartedAt = $cycleStarted

  if ($null -eq $State) { $State = [pscustomobject]@{} }
  Set-DynamicProperty $State 'observedAt' $observed.ToString('o')
  Set-DynamicProperty $State 'connected' ([bool]$Snapshot.connected)
  Set-DynamicProperty $State 'workActive' $workActive
  Set-DynamicProperty $State 'workSignal' $workSignal
  Set-DynamicProperty $State 'workDay' $day
  Set-DynamicProperty $State 'workedTodaySeconds' $worked
  Set-DynamicProperty $State 'onlineTodaySeconds' $online
  Set-DynamicProperty $State 'currentCycleStartedAt' $cycleStarted
  return $State
}

function New-FtpRequest {
  param([string]$HostName, [string]$Method, [string]$RemotePath = '')
  $escaped = ''
  if ($RemotePath) { $escaped = [Uri]::EscapeDataString($RemotePath).Replace('%2F', '/') }
  $uri = if ($escaped) { "ftp://$HostName/$escaped" } else { "ftp://$HostName/" }
  $request = [Net.FtpWebRequest]::Create($uri)
  $request.Method = $Method
  $request.Credentials = New-Object Net.NetworkCredential('anonymous', 'yingma-machine-watcher@localhost')
  $request.UseBinary = $true
  $request.UsePassive = $true
  $request.KeepAlive = $false
  $request.Timeout = 6000
  $request.ReadWriteTimeout = 6000
  return $request
}

function Get-FtpListing {
  param([string]$HostName, [string]$TimeZoneId)
  $request = New-FtpRequest $HostName ([Net.WebRequestMethods+Ftp]::ListDirectoryDetails)
  $response = $request.GetResponse()
  try {
    $reader = New-Object IO.StreamReader($response.GetResponseStream(), [Text.Encoding]::UTF8, $true)
    try { $text = $reader.ReadToEnd() } finally { $reader.Dispose() }
  } finally { $response.Dispose() }

  $files = @()
  foreach ($line in ($text -split "`r?`n")) {
    if (-not $line.Trim()) { continue }
    $match = [regex]::Match(
      $line,
      '^(?<mode>[-dl])\S*\s+\d+\s+\S+\s+\S+\s+(?<size>\d+)\s+(?<month>[A-Za-z]{3})\s+(?<day>\d{1,2})\s+(?<stamp>\d{2}:\d{2}|\d{4})\s+(?<name>.+)$'
    )
    if (-not $match.Success -or $match.Groups['mode'].Value -ne '-') { continue }
    $files += [pscustomobject]@{
      Name = $match.Groups['name'].Value.Trim()
      SizeBytes = [int64]$match.Groups['size'].Value
      ModifiedAt = Convert-FtpStampToUtc `
        $match.Groups['month'].Value `
        $match.Groups['day'].Value `
        $match.Groups['stamp'].Value `
        $TimeZoneId
    }
  }
  return @($files)
}

function Convert-FtpStampToUtc {
  param([string]$Month, [string]$Day, [string]$Stamp, [string]$TimeZoneId)
  try {
    $year = [DateTime]::Now.Year
    $time = '00:00'
    if ($Stamp -match '^\d{4}$') { $year = [int]$Stamp } else { $time = $Stamp }
    $local = [DateTime]::ParseExact(
      "$Month $Day $year $time",
      'MMM d yyyy HH:mm',
      [Globalization.CultureInfo]::InvariantCulture,
      [Globalization.DateTimeStyles]::AllowWhiteSpaces
    )
    if ($Stamp -match ':' -and $local -gt [DateTime]::Now.AddDays(2)) { $local = $local.AddYears(-1) }
    $zone = [TimeZoneInfo]::FindSystemTimeZoneById($TimeZoneId)
    return [TimeZoneInfo]::ConvertTimeToUtc([DateTime]::SpecifyKind($local, 'Unspecified'), $zone).ToString('o')
  } catch { return $null }
}

function Get-FtpFileHead {
  param([string]$HostName, [string]$Name, [int]$MaxBytes)
  $request = New-FtpRequest $HostName ([Net.WebRequestMethods+Ftp]::DownloadFile) $Name
  $response = $request.GetResponse()
  $memory = New-Object IO.MemoryStream
  try {
    $stream = $response.GetResponseStream()
    try {
      $buffer = New-Object byte[] 8192
      while ($memory.Length -lt $MaxBytes) {
        $remaining = [Math]::Min($buffer.Length, $MaxBytes - [int]$memory.Length)
        $read = $stream.Read($buffer, 0, $remaining)
        if ($read -le 0) { break }
        $memory.Write($buffer, 0, $read)
      }
    } finally { $stream.Dispose() }
    $bytes = $memory.ToArray()
  } finally {
    $memory.Dispose()
    $response.Dispose()
  }

  # Lynuc installations commonly store Chinese comments as GBK. ASCII NC
  # headers parse identically in either encoding; GBK preserves the source
  # part name for the dashboard when Windows has code page 936 available.
  try { $encoding = [Text.Encoding]::GetEncoding(936) }
  catch { $encoding = [Text.Encoding]::UTF8 }
  return $encoding.GetString($bytes)
}

function Get-Hash {
  param([string]$Text)
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [Text.Encoding]::UTF8.GetBytes($Text)
    return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
  } finally { $sha.Dispose() }
}

function Convert-DurationToken {
  param([string]$Token)
  if ($Token -match '^(?<a>\d+):(?<b>\d+)h$') { return ([int]$Matches.a * 3600) + ([int]$Matches.b * 60) }
  if ($Token -match '^(?<a>\d+):(?<b>\d+)m$') { return ([int]$Matches.a * 60) + [int]$Matches.b }
  if ($Token -match '^(?<a>\d+):(?<b>\d+)s$') { return [int]$Matches.a }
  return $null
}

function Convert-CamDateToUtc {
  param([string]$Text, [string]$TimeZoneId)
  $patterns = @(
    '(?im)Program Date\s*:\s*(?<date>\d{4}-\d{2}-\d{2})\s+Clock\s*:\s*(?<time>\d{2}:\d{2}:\d{2})',
    '(?im)DATE\s*:\s*(?<date>\d{4}/\d{2}/\d{2})\s+(?<time>\d{2}:\d{2}:\d{2})'
  )
  foreach ($pattern in $patterns) {
    $match = [regex]::Match($Text, $pattern)
    if (-not $match.Success) { continue }
    try {
      $raw = ($match.Groups['date'].Value.Replace('/', '-')) + ' ' + $match.Groups['time'].Value
      $local = [DateTime]::ParseExact($raw, 'yyyy-MM-dd HH:mm:ss', [Globalization.CultureInfo]::InvariantCulture)
      $zone = [TimeZoneInfo]::FindSystemTimeZoneById($TimeZoneId)
      return [TimeZoneInfo]::ConvertTimeToUtc([DateTime]::SpecifyKind($local, 'Unspecified'), $zone).ToString('o')
    } catch { return $null }
  }
  return $null
}

function Get-ProgramAnalysis {
  param($Entry, [string]$Content, [string]$TimeZoneId)
  $programNumber = $null
  $programMatch = [regex]::Match($Content, '(?im)^\s*(O\d+)\b')
  if ($programMatch.Success) { $programNumber = $programMatch.Groups[1].Value }

  $sourcePath = $null
  $sourceMatch = [regex]::Match(
    $Content,
    '(?im)^\s*\(\s*(?:PartFileName\d*|PART)\s*[:=]\s*(?<part>.+?)\s*\)\s*$'
  )
  if ($sourceMatch.Success) { $sourcePath = $sourceMatch.Groups['part'].Value.Trim() }
  $sourcePart = $null
  if ($sourcePath) {
    try {
      $leaf = ($sourcePath -split '[\\/]')[-1]
      $sourcePart = [IO.Path]::GetFileNameWithoutExtension($leaf)
    }
    catch { $sourcePart = $sourcePath }
  }

  $controller = $null
  $controllerMatch = [regex]::Match($Content, '(?im)\(\s*(?:Controller|MACH)\s*:\s*([^\r\n\)]+)\)')
  if ($controllerMatch.Success) { $controller = $controllerMatch.Groups[1].Value.Trim() }

  $operations = @()
  $operationPattern = '(?im)^\(\s*N(?<number>\d+)\s*\|\s*T(?<tool>\d+)\s*\|\s*Z(?<depth>-?\d+(?:\.\d+)?)\s*\|\s*(?<duration>\d+:\d+[hms])\s*\|\s*(?<cutter>.*?)\s*\)'
  foreach ($match in [regex]::Matches($Content, $operationPattern)) {
    $operations += [pscustomobject]@{
      number = [int]$match.Groups['number'].Value
      tool = [int]$match.Groups['tool'].Value
      depthMm = [double]$match.Groups['depth'].Value
      durationSeconds = Convert-DurationToken $match.Groups['duration'].Value
      cutter = $match.Groups['cutter'].Value.Trim()
    }
  }

  $estimated = $null
  $totalMatch = [regex]::Match($Content, '(?im)Total Machine Time\s*:\s*(\d+:\d+[hms])')
  if ($totalMatch.Success) { $estimated = Convert-DurationToken $totalMatch.Groups[1].Value }
  if ($null -eq $estimated -and $operations.Count -gt 0) {
    $estimated = 0
    foreach ($operation in $operations) {
      if ($null -ne $operation.durationSeconds) { $estimated += $operation.durationSeconds }
    }
  }

  $toolSet = @{}
  foreach ($match in [regex]::Matches($Content, '(?im)(?:^|\s)T(\d+)\b')) {
    $toolSet[[int]$match.Groups[1].Value] = $true
  }
  $tools = @($toolSet.Keys | Sort-Object)

  $spindle = $null
  $spindleMatch = [regex]::Match($Content, '(?im)(?:^|\s)S(\d+(?:\.\d+)?)\b')
  if ($spindleMatch.Success) { $spindle = [int][double]$spindleMatch.Groups[1].Value }
  $feed = $null
  $feedMatch = [regex]::Match($Content, '(?im)(?:^|\s)F(\d+(?:\.\d+)?)\b')
  if ($feedMatch.Success) { $feed = [double]$feedMatch.Groups[1].Value }

  return [pscustomobject]@{
    programNumber = $programNumber
    sourcePart = $sourcePart
    sourcePartPath = $sourcePath
    controller = $controller
    camProgrammedAt = Convert-CamDateToUtc $Content $TimeZoneId
    estimatedDurationSeconds = $estimated
    operationCount = if ($operations.Count -gt 0) { $operations.Count } else { $null }
    currentOperation = $null
    operations = @($operations)
    toolNumbers = @($tools)
    spindleRpm = $spindle
    feedMmMin = $feed
  }
}

function Test-MainProgram {
  param($File, [int64]$MinBytes)
  if ($File.Name -notmatch '(?i)\.(?:nc|n)$') { return $false }
  if ($File.SizeBytes -lt $MinBytes) { return $false }
  if ($File.Name -match '(?i)^(?:O\d{3,}|PROBE_|SP-L-TEST)') { return $false }
  if ($File.Name -match '(?i)-D[23]\.nc$') { return $false }
  return $true
}

function Get-MachineSnapshot {
  param($Machine, $Config, $Previous)
  $observedAt = [DateTimeOffset]::UtcNow
  $started = [Diagnostics.Stopwatch]::StartNew()
  try {
    $files = @(Get-FtpListing ([string]$Machine.ip) ([string]$Config.ftpTimeZoneId))
    $started.Stop()
    $programFiles = @($files | Where-Object { $_.Name -match '(?i)\.(?:nc|n|txt)$' })
    $mainPrograms = @($programFiles | Where-Object { Test-MainProgram $_ ([int64]$Config.minMainProgramBytes) })
    $orderedMain = @($mainPrograms | Sort-Object `
      @{ Expression = { if ($_.ModifiedAt) { Convert-IsoOffset $_.ModifiedAt } else { [DateTimeOffset]::MinValue } }; Descending = $true }, `
      @{ Expression = { $_.SizeBytes }; Descending = $true })
    $latest = if ($orderedMain.Count -gt 0) { $orderedMain[0] } else { $null }

    if ($null -eq $latest) {
      return [pscustomobject]@{
        snapshot = New-SnapshotBase $Machine $observedAt.ToString('o') $true 'idle' $started.ElapsedMilliseconds $null
        state = [pscustomobject]@{ currentProgram = $null; programFingerprint = $null; jobStartedAt = $null; lastChangeAt = $null }
      }
    }

    $content = Get-FtpFileHead ([string]$Machine.ip) ([string]$latest.Name) ([int]$Config.maxProgramReadBytes)
    $analysis = Get-ProgramAnalysis $latest $content ([string]$Config.camTimeZoneId)
    $fingerprint = Get-Hash ("{0}|{1}|{2}" -f $latest.Name, $latest.SizeBytes, $latest.ModifiedAt)
    $previousProgram = if ($null -ne $Previous) { [string](Get-DynamicProperty $Previous 'currentProgram') } else { '' }
    $previousFingerprint = if ($null -ne $Previous) { [string](Get-DynamicProperty $Previous 'programFingerprint') } else { '' }
    $sameProgram = $previousProgram -eq [string]$latest.Name
    $changed = $sameProgram -and $previousFingerprint -and $previousFingerprint -ne $fingerprint

    $jobStartedAt = $observedAt.ToString('o')
    if ($sameProgram) {
      $storedStart = Get-DynamicProperty $Previous 'jobStartedAt'
      if ($storedStart) { $jobStartedAt = (Convert-IsoOffset $storedStart).ToString('o') }
    }

    $lastChangeAt = $null
    if ($changed) {
      $lastChangeAt = $observedAt.ToString('o')
    } elseif ($sameProgram) {
      $storedChange = Get-DynamicProperty $Previous 'lastChangeAt'
      if ($storedChange) { $lastChangeAt = (Convert-IsoOffset $storedChange).ToString('o') }
    } elseif ($latest.ModifiedAt) {
      $modified = Convert-IsoOffset $latest.ModifiedAt
      if (($observedAt - $modified).TotalMinutes -le [double]$Config.activeWindowMinutes) {
        $lastChangeAt = $latest.ModifiedAt
      }
    }

    $machineState = 'ready'
    if ($lastChangeAt) {
      $lastChange = Convert-IsoOffset $lastChangeAt
      if (($observedAt - $lastChange).TotalMinutes -le [double]$Config.activeWindowMinutes) {
        $machineState = 'programming'
      }
    }

    $recent = @($programFiles | Sort-Object `
      @{ Expression = { if ($_.ModifiedAt) { Convert-IsoOffset $_.ModifiedAt } else { [DateTimeOffset]::MinValue } }; Descending = $true }, `
      @{ Expression = { $_.SizeBytes }; Descending = $true } |
      Select-Object -First 8 |
      ForEach-Object { [pscustomobject]@{ name = $_.Name; sizeBytes = $_.SizeBytes; modifiedAt = $_.ModifiedAt } })

    $snapshot = New-SnapshotBase $Machine $observedAt.ToString('o') $true $machineState $started.ElapsedMilliseconds $null
    $snapshot.currentProgram = [string]$latest.Name
    $snapshot.programFingerprint = $fingerprint
    $snapshot.programModifiedAt = $latest.ModifiedAt
    $snapshot.programSizeBytes = [int64]$latest.SizeBytes
    $snapshot.programCount = $programFiles.Count
    $snapshot.mainProgramCount = $mainPrograms.Count
    $snapshot.programNumber = $analysis.programNumber
    $snapshot.sourcePart = $analysis.sourcePart
    $snapshot.sourcePartPath = $analysis.sourcePartPath
    $snapshot.controller = $analysis.controller
    $snapshot.camProgrammedAt = $analysis.camProgrammedAt
    $snapshot.estimatedDurationSeconds = $analysis.estimatedDurationSeconds
    $snapshot.operationCount = $analysis.operationCount
    $snapshot.currentOperation = $analysis.currentOperation
    $snapshot.operations = @($analysis.operations)
    $snapshot.toolNumbers = @($analysis.toolNumbers)
    $snapshot.spindleRpm = $analysis.spindleRpm
    $snapshot.feedMmMin = $analysis.feedMmMin
    $snapshot.jobStartedAt = $jobStartedAt
    $snapshot.recentPrograms = @($recent)

    return [pscustomobject]@{
      snapshot = $snapshot
      state = [pscustomobject]@{
        currentProgram = [string]$latest.Name
        programFingerprint = $fingerprint
        jobStartedAt = $jobStartedAt
        lastChangeAt = $lastChangeAt
      }
    }
  } catch {
    $started.Stop()
    return [pscustomobject]@{
      snapshot = New-SnapshotBase $Machine $observedAt.ToString('o') $false 'offline' $null $_.Exception.Message
      state = $Previous
    }
  }
}

function New-SnapshotBase {
  param($Machine, [string]$ObservedAt, [bool]$Connected, [string]$State, $LatencyMs, $ErrorText)
  return [pscustomobject]@{
    id = [string]$Machine.id
    name = [string]$Machine.name
    ip = [string]$Machine.ip
    connected = $Connected
    state = $State
    observedAt = $ObservedAt
    jobStartedAt = $null
    currentProgram = $null
    programFingerprint = $null
    programModifiedAt = $null
    programSizeBytes = $null
    programCount = 0
    mainProgramCount = 0
    programNumber = $null
    sourcePart = $null
    sourcePartPath = $null
    controller = $null
    camProgrammedAt = $null
    estimatedDurationSeconds = $null
    operationCount = $null
    currentOperation = $null
    operations = @()
    toolNumbers = @()
    spindleRpm = $null
    feedMmMin = $null
    completedParts = $null
    targetParts = $null
    executionState = 'unknown'
    workSignal = 'unavailable'
    workDay = ''
    workedTodaySeconds = 0
    onlineTodaySeconds = 0
    currentCycleStartedAt = $null
    ftpLatencyMs = $LatencyMs
    recentPrograms = @()
    error = $ErrorText
  }
}

function Send-Payload {
  param($Config, $Payload)
  $json = $Payload | ConvertTo-Json -Depth 12 -Compress
  Set-Content -LiteralPath $PendingPath -Value $json -Encoding UTF8
  $headers = @{ Authorization = 'Bearer ' + [string]$Config.token }
  $result = Invoke-RestMethod `
    -Uri ([string]$Config.endpoint) `
    -Method Post `
    -Headers $headers `
    -ContentType 'application/json; charset=utf-8' `
    -Body $json `
    -TimeoutSec 20 `
    -UseBasicParsing
  if (-not $result.ok) { throw "Server rejected payload: $($result.error)" }
  Remove-Item -LiteralPath $PendingPath -Force -ErrorAction SilentlyContinue
}

if (-not (Test-Path -LiteralPath $ConfigPath)) { throw "Missing config file: $ConfigPath" }
$config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $config.endpoint -or -not $config.token -or -not $config.machines) { throw 'config.json is incomplete' }
if (-not (Get-DynamicProperty $config 'ftpTimeZoneId')) { $config | Add-Member -NotePropertyName ftpTimeZoneId -NotePropertyValue 'UTC' }
if (-not (Get-DynamicProperty $config 'camTimeZoneId')) { $config | Add-Member -NotePropertyName camTimeZoneId -NotePropertyValue 'China Standard Time' }
if (-not (Get-DynamicProperty $config 'workTimeZoneId')) { $config | Add-Member -NotePropertyName workTimeZoneId -NotePropertyValue 'China Standard Time' }
if (-not (Get-DynamicProperty $config 'pollSeconds')) { $config | Add-Member -NotePropertyName pollSeconds -NotePropertyValue 15 }
if (-not (Get-DynamicProperty $config 'minMainProgramBytes')) { $config | Add-Member -NotePropertyName minMainProgramBytes -NotePropertyValue 50000 }
if (-not (Get-DynamicProperty $config 'maxProgramReadBytes')) { $config | Add-Member -NotePropertyName maxProgramReadBytes -NotePropertyValue 524288 }
if (-not (Get-DynamicProperty $config 'activeWindowMinutes')) { $config | Add-Member -NotePropertyName activeWindowMinutes -NotePropertyValue 5 }

$mutex = New-Object Threading.Mutex($false, 'Global\YingmaMachineWatcher')
if (-not $mutex.WaitOne(0, $false)) { throw 'Yingma Machine Watcher is already running' }

try {
  Write-WatcherLog "Watcher $WatcherVersion started; $($config.machines.Count) machines configured"
  do {
    $cycleAt = [DateTimeOffset]::UtcNow.ToString('o')
    $saved = Read-JsonFile $StatePath ([pscustomobject]@{ machines = [pscustomobject]@{} })
    if ($null -eq (Get-DynamicProperty $saved 'machines')) {
      $saved = [pscustomobject]@{ machines = [pscustomobject]@{} }
    }
    $nextMachines = @{}
    $snapshots = @()
    foreach ($machine in $config.machines) {
      $previous = Get-DynamicProperty $saved.machines ([string]$machine.id)
      $result = Get-MachineSnapshot $machine $config $previous
      $result.state = Update-DailyTelemetry $machine $config $previous $result.snapshot $result.state
      $snapshots += $result.snapshot
      $nextMachines[[string]$machine.id] = $result.state
      $detail = if ($result.snapshot.currentProgram) { $result.snapshot.currentProgram } else { $result.snapshot.error }
      Write-WatcherLog ("{0} {1} {2}" -f $machine.name, $result.snapshot.state, $detail)
    }

    Write-JsonAtomic $StatePath ([pscustomobject]@{ machines = $nextMachines })
    $payload = [pscustomobject]@{
      watcherId = [string]$config.watcherId
      watcherVersion = $WatcherVersion
      observedAt = $cycleAt
      machines = @($snapshots)
    }
    try {
      Send-Payload $config $payload
      Write-WatcherLog "Uploaded $($snapshots.Count) machine snapshots"
    } catch {
      Write-WatcherLog "Upload failed; latest payload retained: $($_.Exception.Message)" 'ERROR'
    }

    if (-not $Once) { Start-Sleep -Seconds ([Math]::Max(5, [int]$config.pollSeconds)) }
  } while (-not $Once)
} finally {
  $mutex.ReleaseMutex()
  $mutex.Dispose()
}
