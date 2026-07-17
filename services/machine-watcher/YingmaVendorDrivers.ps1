#requires -Version 5.1

# Read-only native CNC adapters. This module deliberately imports no write,
# search, delete, reset, or cycle-control entry points from either vendor API.

$script:YingmaAutoDriverCache = @{}
$script:YingmaComInvokerReady = $false
$script:YingmaFocasInteropReady = $false

function Initialize-YingmaComInvoker {
  if ($script:YingmaComInvokerReady) { return }
  if ($null -eq ('Yingma.Cnc.ComInvoker' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Globalization;
using System.Reflection;

namespace Yingma.Cnc {
  public static class ComInvoker {
    public static object Invoke(object target, string method, object[] args, int[] byRefIndexes) {
      ParameterModifier[] modifiers = null;
      if (byRefIndexes.Length > 0) {
        ParameterModifier modifier = new ParameterModifier(args.Length);
        for (int i = 0; i < byRefIndexes.Length; i++) modifier[byRefIndexes[i]] = true;
        modifiers = new ParameterModifier[] { modifier };
      }
      return target.GetType().InvokeMember(
        method,
        BindingFlags.InvokeMethod,
        null,
        target,
        args,
        modifiers,
        CultureInfo.InvariantCulture,
        null
      );
    }
  }
}
'@
  }
  $script:YingmaComInvokerReady = $true
}

function Invoke-YingmaComMethod {
  param($Target, [string]$Method, [object[]]$Arguments = @(), [int[]]$ByRefIndexes = @())
  Initialize-YingmaComInvoker
  $argsCopy = [object[]]$Arguments.Clone()
  $returnValue = [Yingma.Cnc.ComInvoker]::Invoke($Target, $Method, $argsCopy, $ByRefIndexes)
  return [pscustomobject]@{ code = [int64]$returnValue; arguments = $argsCopy }
}

function Assert-YingmaVendorCode {
  param([int64]$Code, [string]$Operation)
  if ($Code -eq 0) { return }
  $unsigned = [uint32]($Code -band 0xffffffffL)
  throw "$Operation failed: 0x$($unsigned.ToString('X8'))"
}

function Convert-YingmaPackedTime {
  param($Value)
  if ($null -eq $Value) { return $null }
  $digits = ([int64]$Value).ToString('000000')
  if ($digits.Length -lt 6) { return $null }
  $hoursText = $digits.Substring(0, $digits.Length - 4)
  $minutes = [int]$digits.Substring($digits.Length - 4, 2)
  $seconds = [int]$digits.Substring($digits.Length - 2, 2)
  if ($minutes -gt 59 -or $seconds -gt 59) { return $null }
  return ([int64]$hoursText * 3600) + ($minutes * 60) + $seconds
}

function Convert-YingmaBytesToText {
  param([byte[]]$Bytes)
  if ($null -eq $Bytes -or $Bytes.Length -eq 0) { return '' }
  try { return [Text.Encoding]::GetEncoding(936).GetString($Bytes).TrimEnd([char]0) }
  catch { return [Text.Encoding]::UTF8.GetString($Bytes).TrimEnd([char]0) }
}

function Resolve-YingmaCncDriver {
  param($Machine)
  $configured = [string](Get-CncConfigValue $Machine 'driver' 'auto')
  if ($configured -ne 'auto' -and $configured -ne 'inventory') { return $configured }
  $address = [string]$Machine.ip
  if ($script:YingmaAutoDriverCache.ContainsKey($address)) { return [string]$script:YingmaAutoDriverCache[$address] }
  if ((Test-TcpPort $address 8193 900).open) {
    $script:YingmaAutoDriverCache[$address] = 'focas'
  } elseif ((Test-TcpPort $address 683 900).open) {
    $script:YingmaAutoDriverCache[$address] = 'ezsocket'
  } elseif ((Test-TcpPort $address 21 900).open) {
    $script:YingmaAutoDriverCache[$address] = 'ftp'
  } elseif ((Test-TcpPort $address 502 900).open) {
    $script:YingmaAutoDriverCache[$address] = 'lynuc'
  } else {
    # Do not cache a negative probe. At Windows boot the NIC/VLAN can become
    # ready after the SYSTEM task starts; the next poll must identify it again.
    return 'inventory'
  }
  return [string]$script:YingmaAutoDriverCache[$address]
}

function Reset-YingmaAutoDriver {
  param($Machine)
  if ([string](Get-CncConfigValue $Machine 'driver' 'auto') -eq 'auto') {
    $script:YingmaAutoDriverCache.Remove([string]$Machine.ip)
  }
}

function Get-YingmaEzDirectory {
  param($Com, [string]$Path, [int]$Maximum = 256)
  $items = @()
  try {
    $result = Invoke-YingmaComMethod $Com 'File_FindDir2' @([string]$Path, [int]0, [string]'') @(2)
    while ($result.code -gt 0 -and $items.Count -lt $Maximum) {
      $text = [string]$result.arguments[2]
      $parts = @($text -split "`t")
      $items += [pscustomobject]@{
        name = if ($parts.Count -gt 0) { $parts[0] } else { $text }
        sizeBytes = if ($parts.Count -gt 1 -and $parts[1] -match '^\d+$') { [int64]$parts[1] } else { 0 }
        comment = if ($parts.Count -gt 2) { $parts[2] } else { $null }
      }
      $result = Invoke-YingmaComMethod $Com 'File_FindNextDir2' @([string]'') @(0)
    }
  } finally {
    try { $null = (Invoke-YingmaComMethod $Com 'File_ResetDir').code } catch {}
  }
  return @($items)
}

function Get-YingmaEzProgramSource {
  param($Com, [string]$Path, [int]$MaximumBytes)
  $failures = @()
  foreach ($api in @(
    [pscustomobject]@{ open = 'File_OpenNCFile3'; read = 'File_ReadNCFile3'; close = 'File_CloseNCFile3' },
    [pscustomobject]@{ open = 'File_OpenFile3'; read = 'File_ReadFile2'; close = 'File_CloseFile2' }
  )) {
    $opened = $false
    $memory = New-Object IO.MemoryStream
    try {
      $code = (Invoke-YingmaComMethod $Com $api.open @([string]$Path, [int]1)).code
      if ($code -ne 0) {
        $failures += "$($api.open)=0x$(([uint32]($code -band 0xffffffffL)).ToString('X8'))"
        continue
      }
      $opened = $true
      while ($memory.Length -lt $MaximumBytes) {
        $amount = [Math]::Min(8192, $MaximumBytes - [int]$memory.Length)
        $result = Invoke-YingmaComMethod $Com $api.read @([int]$amount, $null) @(1)
        Assert-YingmaVendorCode $result.code "EZSocket $($api.read)"
        [byte[]]$chunk = @($result.arguments[1])
        if ($chunk.Length -eq 0) { break }
        $memory.Write($chunk, 0, $chunk.Length)
        if ($chunk.Length -lt $amount) { break }
      }
      return $memory.ToArray()
    } catch {
      $failures += "$($api.open)/$($api.read)=$($_.Exception.Message)"
    } finally {
      $memory.Dispose()
      if ($opened) { try { $null = (Invoke-YingmaComMethod $Com $api.close).code } catch {} }
    }
  }
  throw "NC source path $Path failed: $($failures -join '; ')"
}

function Get-YingmaEzWorkCount {
  param($Com)
  try {
    # Mitsubishi M800/M80 parameter manual: #8002 is current WRK COUNT and
    # #8003 is WRK COUNT LIMIT. This call is read-only.
    $result = Invoke-YingmaComMethod $Com 'Parameter_GetData3' @([int]0, [int]8002, [int]2, [int]0, $null) @(4)
    $values = @($result.arguments[4])
    $count = $null
    $target = $null
    if ($result.code -eq 0 -and $values.Count -ge 1 -and [string]$values[0] -match '^-?\d+$') { $count = [int64]$values[0] }
    if ($result.code -eq 0 -and $values.Count -ge 2 -and [string]$values[1] -match '^-?\d+$') { $target = [int64]$values[1] }
    return [pscustomobject]@{ code = $result.code; values = $values; count = $count; target = $target; readable = ($null -ne $count) }
  } catch {
    return [pscustomobject]@{ code = $null; values = @(); count = $null; target = $null; readable = $false; error = $_.Exception.Message }
  }
}

function Get-YingmaEzMesTelemetry {
  param($Com)
  # M800/M80 system 1 MES interface library block. Device_ReadBlock2 is a
  # read-only batch API; WORD is value 2 in the EZSocket automation constants.
  try {
    $result = Invoke-YingmaComMethod $Com 'Device_ReadBlock2' @([int]0, [int]64, [string]'R14700', [int]2, $null) @(4)
    $rawValues = $result.arguments[4]
    [uint32[]]$values = if ($null -eq $rawValues) { @() } else { @($rawValues) }
    $endEpoch = $null
    if ($result.code -eq 0 -and $values.Count -ge 6) {
      [uint64]$lowFirst = [uint64]$values[2] -bor ([uint64]$values[3] -shl 16)
      [uint64]$highFirst = ([uint64]$values[2] -shl 16) -bor [uint64]$values[3]
      $minimum = [DateTimeOffset]::Parse('2000-01-01T00:00:00Z').ToUnixTimeSeconds()
      $maximum = [DateTimeOffset]::Parse('2100-01-01T00:00:00Z').ToUnixTimeSeconds()
      if ($lowFirst -ge $minimum -and $lowFirst -le $maximum) { $endEpoch = [int64]$lowFirst }
      elseif ($highFirst -ge $minimum -and $highFirst -le $maximum) { $endEpoch = [int64]$highFirst }
    }
    return [pscustomobject]@{
      readable = ($result.code -eq 0 -and $values.Count -gt 0)
      code = $result.code
      headDevice = 'R14700'
      words = @($values)
      machiningEndEpoch = $endEpoch
    }
  } catch {
    return [pscustomobject]@{ readable = $false; code = $null; headDevice = 'R14700'; words = @(); machiningEndEpoch = $null; error = $_.Exception.Message }
  }
}

function Get-YingmaEzSocketSnapshot {
  param($Machine, $Config, $Previous)
  $observed = [DateTimeOffset]::UtcNow
  $watch = [Diagnostics.Stopwatch]::StartNew()
  $com = $null
  $opened = $false
  try {
    Initialize-YingmaComInvoker
    try {
      # Mitsubishi's VC# late-binding sample deliberately uses the unversioned
      # ProgID and resolves members from the created object's runtime type.
      $comType = [Type]::GetTypeFromProgID('EZNcAut.DispEZNcCommunication')
      if ($null -eq $comType) { throw 'ProgID is not registered' }
      $com = [Activator]::CreateInstance($comType)
    }
    catch { throw 'Mitsubishi FCSB1224W100/EZSocket runtime is not installed or COM registration is unavailable' }

    $tcpResult = Invoke-YingmaComMethod $com 'SetTCPIPProtocol' @([string]$Machine.ip, [int]683)
    Assert-YingmaVendorCode $tcpResult.code 'EZSocket SetTCPIPProtocol'
    $openErrors = @()
    $systemType = $null
    # Official Mitsubishi automation samples use system type 9 for M800M.
    # Type 10 is M800L. Both are tried because the network port does not reveal
    # machining-center versus lathe configuration.
    foreach ($candidate in @(9, 10)) {
      try {
        $openResult = Invoke-YingmaComMethod $com 'Open3' @([int]$candidate, [int]1, [int]30, [string]'EZNC_LOCALHOST')
        $code = $openResult.code
        if ($code -eq 0) { $opened = $true; $systemType = $candidate; break }
        $openErrors += "type=$candidate/code=0x$(([uint32]($code -band 0xffffffffL)).ToString('X8'))"
      } catch { $openErrors += "type=$candidate/$($_.Exception.Message)" }
    }
    if (-not $opened) { throw "EZSocket could not open M80/E80: $($openErrors -join '; ')" }
    $headResult = Invoke-YingmaComMethod $com 'SetHead' @([int]1)
    Assert-YingmaVendorCode $headResult.code 'EZSocket SetHead'

    $raw = [ordered]@{ adapter = 'ezsocket'; systemType = $systemType; port = 683; calls = [ordered]@{} }
    $readOut = {
      param([string]$Name, [object[]]$Arguments, [int[]]$ByRef)
      try {
        $result = Invoke-YingmaComMethod $com $Name $Arguments $ByRef
        $raw.calls[$Name] = [ordered]@{ code = $result.code; outputs = @($ByRef | ForEach-Object { $result.arguments[$_] }) }
        if ($result.code -ne 0) { return $null }
        return $result
      } catch {
        $raw.calls[$Name] = [ordered]@{ error = $_.Exception.Message }
        return $null
      }
    }

    $programResult = $null
    $programType = $null
    foreach ($candidateType in @(0, 1)) {
      $candidateProgram = & $readOut 'Program_GetProgramNumber2' @([int]$candidateType, [string]'') @(1)
      if ($candidateProgram -and ([string]$candidateProgram.arguments[1]).Trim()) {
        $programResult = $candidateProgram
        $programType = $candidateType
        break
      }
    }
    $raw.programType = $programType
    $program = if ($programResult) { ([string]$programResult.arguments[1]).Trim() } else { '' }
    $blockResult = & $readOut 'Program_CurrentBlockRead' @([int]10, [string]'', [int]0) @(1, 2)
    $run = & $readOut 'Status_GetRunStatus' @([int]1, [int]0) @(1)
    $start = & $readOut 'Status_GetRunStatus' @([int]2, [int]0) @(1)
    $pause = & $readOut 'Status_GetRunStatus' @([int]3, [int]0) @(1)
    $cycle = & $readOut 'Status_GetCycleTime' @([int]0) @(0)
    $runTime = & $readOut 'Time_GetRunTime' @([int]0) @(0)
    $startTime = & $readOut 'Time_GetStartTime' @([int]0) @(0)
    $spindle = & $readOut 'Monitor_GetSpindleMonitor' @([int]2, [int]1, [int]0, [string]'') @(2, 3)
    $feed = & $readOut 'Position_GetFeedSpeed' @([int]3, [double]0) @(1)
    $workCount = Get-YingmaEzWorkCount $com
    $raw.workCount = $workCount
    $mes = Get-YingmaEzMesTelemetry $com
    $raw.mesSystem1 = $mes

    $isStarted = $start -and [int64]$start.arguments[1] -eq 1
    $isPaused = $pause -and [int64]$pause.arguments[1] -eq 1
    $isAuto = $run -and [int64]$run.arguments[1] -eq 1
    $execution = if ($isStarted) { 'running' } elseif ($isPaused) { 'paused' } elseif ($isAuto) { 'stopped' } else { 'stopped' }
    $drive = 'M01:\PRG\USER\'
    $directory = @(Get-YingmaEzDirectory $com $drive)
    $raw.directory = @($directory)

    $sourceBytes = $null
    $sourceError = $null
    $fingerprintSeed = $program
    $previousCapture = [string](Get-DynamicProperty $Previous 'programSourceCapturedFor')
    $captureSource = $program -and $program -ne $previousCapture
    if ($captureSource) {
      $sourceFailures = @()
      $programPaths = if ($program -match '^[A-Za-z]\d*:') {
        @($program)
      } else {
        @($drive + $program, 'M01:\IC1\' + $program)
      }
      foreach ($programPath in $programPaths) {
        try {
          $sourceBytes = Get-YingmaEzProgramSource $com $programPath ([int]$Config.maxProgramReadBytes)
          $raw.programSourcePath = $programPath
          $fingerprintSeed = Get-Hash (Convert-YingmaBytesToText $sourceBytes)
          break
        } catch { $sourceFailures += $_.Exception.Message }
      }
      if (-not $sourceBytes) { $sourceError = $sourceFailures -join ' | ' }
    }
    $content = if ($sourceBytes) { Convert-YingmaBytesToText $sourceBytes } else { '' }
    $entry = [pscustomobject]@{ Name = $program; SizeBytes = if ($sourceBytes) { $sourceBytes.Length } else { 0 }; ModifiedAt = $null }
    $analysis = Get-ProgramAnalysis $entry $content ([string]$Config.camTimeZoneId)

    $snapshot = New-SnapshotBase $Machine $observed.ToString('o') $true $(if ($execution -eq 'running') { 'programming' } elseif ($program) { 'ready' } else { 'idle' }) $watch.ElapsedMilliseconds $null
    $snapshot.driver = 'ezsocket'
    $snapshot.manufacturer = 'Mitsubishi Electric'
    $snapshot.controller = [string](Get-CncConfigValue $Machine 'controller' 'MELDAS M80/E80')
    $snapshot.currentProgram = if ($program) { $program } else { $null }
    $snapshot.programNumber = if ($analysis.programNumber) { $analysis.programNumber } else { if ($program) { $program } else { $null } }
    $snapshot.programFingerprint = if ($fingerprintSeed) { Get-Hash $fingerprintSeed } else { $null }
    $snapshot.programCount = $directory.Count
    $snapshot.mainProgramCount = $directory.Count
    $snapshot.programSizeBytes = if ($sourceBytes) { $sourceBytes.Length } else { $null }
    $snapshot.sourcePart = $analysis.sourcePart
    $snapshot.sourcePartPath = $analysis.sourcePartPath
    $snapshot.camProgrammedAt = $analysis.camProgrammedAt
    $snapshot.estimatedDurationSeconds = $analysis.estimatedDurationSeconds
    $snapshot.operationCount = $analysis.operationCount
    $snapshot.operations = @($analysis.operations)
    $snapshot.toolNumbers = @($analysis.toolNumbers)
    $snapshot.spindleRpm = if ($spindle) { [int64]$spindle.arguments[2] } else { $null }
    $snapshot.feedMmMin = if ($feed) { [double]$feed.arguments[1] } else { $null }
    $snapshot.completedParts = $workCount.count
    $snapshot.totalCompletedParts = $workCount.count
    $snapshot.targetParts = $workCount.target
    $snapshot.currentCycleSeconds = if ($cycle) { Convert-YingmaPackedTime $cycle.arguments[0] } else { $null }
    $snapshot.controllerBootCycleSeconds = if ($runTime) { Convert-YingmaPackedTime $runTime.arguments[0] } else { $null }
    $snapshot.currentCuttingSeconds = if ($startTime) { Convert-YingmaPackedTime $startTime.arguments[0] } else { $null }
    $snapshot.executionState = $execution
    $snapshot.workSignal = 'controller_cycle'
    $snapshot.telemetrySource = 'ezsocket'
    $snapshot.runtimeObservedAt = $observed.ToString('o')
    $snapshot.runtimeLatencyMs = [int]$watch.ElapsedMilliseconds
    $snapshot.runtimeError = $sourceError
    $snapshot.discoveryStatus = 'native_read_ok'
    $snapshot.discoveryConfidence = 100
    $snapshot.discoveredServices = @([pscustomobject]@{ port = 683; name = 'mitsubishi-meldas'; latencyMs = [int]$watch.ElapsedMilliseconds })
    $snapshot.recentPrograms = @($directory | Select-Object -First 12 | ForEach-Object { [pscustomobject]@{ name = $_.name; sizeBytes = $_.sizeBytes; modifiedAt = $null } })
    $snapshot.capabilities = [pscustomobject]@{
      execution = [pscustomobject]@{ readable = $true; source = 'ezsocket'; note = 'Status_GetRunStatus (read-only)' }
      programName = [pscustomobject]@{ readable = [bool]$program; source = 'ezsocket'; note = 'Program_GetProgramNumber2 (read-only)' }
      programSource = [pscustomobject]@{ readable = [bool]$sourceBytes; source = 'ezsocket'; note = 'File_OpenFile3/File_ReadFile2 (read-only)' }
      partCount = [pscustomobject]@{ readable = [bool]$workCount.readable; source = 'ezsocket-parameter'; note = 'Mitsubishi WRK COUNT #8002 and WRK COUNT LIMIT #8003 (read-only)' }
      duration = [pscustomobject]@{ readable = [bool]$cycle; source = 'ezsocket'; note = 'Controller cycle and operation timers' }
    }
    if ($sourceBytes) {
      $snapshot.programSource = $content.Substring(0, [Math]::Min($content.Length, [int]$Config.maxProgramSourceBytes))
      $snapshot.programSourceTruncated = $sourceBytes.Length -ge [int]$Config.maxProgramReadBytes -or $content.Length -gt [int]$Config.maxProgramSourceBytes
      $snapshot.programSourceSha256 = Get-Hash $content
      $snapshot.programSourceCapturedAt = $observed.ToString('o')
    }
    $raw.currentBlock = if ($blockResult) { [string]$blockResult.arguments[1] } else { $null }
    $snapshot.rawTelemetry = [pscustomobject]$raw
    $nextState = if ($null -ne $Previous) { $Previous } else { [pscustomobject]@{} }
    if ($sourceBytes) { Set-DynamicProperty $nextState 'programSourceCapturedFor' $program }
    return [pscustomobject]@{ snapshot = $snapshot; state = $nextState }
  } catch {
    Reset-YingmaAutoDriver $Machine
    $snapshot = New-SnapshotBase $Machine $observed.ToString('o') $false 'error' $watch.ElapsedMilliseconds $_.Exception.Message
    $snapshot.driver = 'ezsocket'; $snapshot.manufacturer = 'Mitsubishi Electric'; $snapshot.controller = 'MELDAS M80/E80'
    $snapshot.runtimeError = $_.Exception.Message; $snapshot.discoveryStatus = 'vendor_runtime_or_controller_error'
    $snapshot.discoveredServices = @([pscustomobject]@{ port = 683; name = 'mitsubishi-meldas'; latencyMs = [int]$watch.ElapsedMilliseconds })
    $snapshot.rawTelemetry = [pscustomobject]@{ adapter = 'ezsocket'; error = $_.Exception.Message }
    return [pscustomobject]@{ snapshot = $snapshot; state = $Previous }
  } finally {
    $watch.Stop()
    if ($opened -and $com) { try { $null = (Invoke-YingmaComMethod $com 'Close').code } catch {} }
    if ($com) { try { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($com) | Out-Null } catch {} }
  }
}

function Initialize-YingmaFocasInterop {
  if ($script:YingmaFocasInteropReady) { return }
  if ($null -eq ('Yingma.Cnc.Focas32' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace Yingma.Cnc {
  [StructLayout(LayoutKind.Sequential, Pack=4)] public struct ODBST2 {
    public short hdck, tmmode, aut, run, motion, mstb, emergency, alarm, edit, warning, o3dchk, ext_opt, restart;
  }
  [StructLayout(LayoutKind.Sequential, Pack=4)] public struct ODBPROO8 {
    public short dummy0, dummy1; public int data, mdata;
  }
  [StructLayout(LayoutKind.Sequential, Pack=4)] public struct ODBM3 {
    public int datano, mcr_val; public short dec_val;
  }
  [StructLayout(LayoutKind.Sequential, Pack=4)] public struct IODBTIME {
    public int minute, msec;
  }
  [StructLayout(LayoutKind.Sequential, Pack=4)] public struct ODBACT {
    public short dummy0, dummy1; public int data;
  }
  public static class Focas32 {
    const string Dll = "Fwlib32.dll";
    [DllImport(Dll, CallingConvention=CallingConvention.Winapi, CharSet=CharSet.Ansi)] public static extern short cnc_allclibhndl3(string ip, ushort port, int timeout, out ushort handle);
    [DllImport(Dll, CallingConvention=CallingConvention.Winapi)] public static extern short cnc_freelibhndl(ushort handle);
    [DllImport(Dll, CallingConvention=CallingConvention.Winapi)] public static extern short cnc_statinfo2(ushort handle, out ODBST2 status);
    [DllImport(Dll, CallingConvention=CallingConvention.Winapi)] public static extern short cnc_rdprgnumo8(ushort handle, out ODBPROO8 program);
    [DllImport(Dll, CallingConvention=CallingConvention.Winapi, CharSet=CharSet.Ansi)] public static extern short cnc_exeprgname2(ushort handle, StringBuilder path);
    [DllImport(Dll, CallingConvention=CallingConvention.Winapi, CharSet=CharSet.Ansi)] public static extern short cnc_rdexecprog(ushort handle, ref ushort length, out short block, byte[] data);
    [DllImport(Dll, CallingConvention=CallingConvention.Winapi)] public static extern short cnc_rdmacro3(ushort handle, int number, short length, out ODBM3 value);
    [DllImport(Dll, CallingConvention=CallingConvention.Winapi)] public static extern short cnc_rdtimer(ushort handle, short type, out IODBTIME value);
    [DllImport(Dll, CallingConvention=CallingConvention.Winapi)] public static extern short cnc_actf(ushort handle, out ODBACT value);
    [DllImport(Dll, CallingConvention=CallingConvention.Winapi)] public static extern short cnc_acts(ushort handle, out ODBACT value);
    [DllImport(Dll, CallingConvention=CallingConvention.Winapi, CharSet=CharSet.Ansi)] public static extern short cnc_upstart4(ushort handle, short type, string path);
    [DllImport(Dll, CallingConvention=CallingConvention.Winapi)] public static extern short cnc_upload4(ushort handle, ref int length, byte[] data);
    [DllImport(Dll, CallingConvention=CallingConvention.Winapi)] public static extern short cnc_upend4(ushort handle);
  }
}
'@
  }
  $script:YingmaFocasInteropReady = $true
}

function Get-YingmaFocasMacro {
  param([uint16]$Handle, [int]$Number, $Raw)
  try {
    $value = New-Object Yingma.Cnc.ODBM3
    $code = [Yingma.Cnc.Focas32]::cnc_rdmacro3($Handle, $Number, 10, [ref]$value)
    $Raw["macro$Number"] = [ordered]@{ code = $code; raw = $value.mcr_val; decimals = $value.dec_val }
    if ($code -ne 0) { return $null }
    return [double]$value.mcr_val / [Math]::Pow(10, [int]$value.dec_val)
  } catch { $Raw["macro$Number"] = [ordered]@{ error = $_.Exception.Message }; return $null }
}

function Get-YingmaFocasSource {
  param([uint16]$Handle, [string]$Path, [int]$MaximumBytes)
  $code = [Yingma.Cnc.Focas32]::cnc_upstart4($Handle, 0, $Path)
  if ($code -ne 0 -and $Path -match '(?i)O?(\d+)') {
    $code = [Yingma.Cnc.Focas32]::cnc_upstart4($Handle, 0, ('O' + $Matches[1]))
  }
  if ($code -ne 0) { throw "FOCAS cnc_upstart4(read-only upload) failed: $code" }
  $memory = New-Object IO.MemoryStream
  try {
    do {
      $requested = [Math]::Min(8192, $MaximumBytes - [int]$memory.Length)
      if ($requested -le 0) { break }
      $buffer = New-Object byte[] $requested
      $length = $requested
      $code = [Yingma.Cnc.Focas32]::cnc_upload4($Handle, [ref]$length, $buffer)
      if ($code -ne 0 -and $code -ne 10) { throw "FOCAS cnc_upload4 failed: $code" }
      if ($length -gt 0) { $memory.Write($buffer, 0, [Math]::Min($length, $buffer.Length)) }
    } while ($code -eq 10 -and $memory.Length -lt $MaximumBytes)
    return $memory.ToArray()
  } finally {
    $memory.Dispose()
    $null = [Yingma.Cnc.Focas32]::cnc_upend4($Handle)
  }
}

function Get-YingmaFocasSnapshot {
  param($Machine, $Config, $Previous)
  $observed = [DateTimeOffset]::UtcNow
  $watch = [Diagnostics.Stopwatch]::StartNew()
  [uint16]$handle = 0
  $connected = $false
  try {
    Initialize-YingmaFocasInterop
    try {
      $dllDirectory = [string](Get-CncConfigValue $Machine 'focasDllDirectory' '')
      if ($dllDirectory) { $env:PATH = "$dllDirectory;$env:PATH" }
      $code = [Yingma.Cnc.Focas32]::cnc_allclibhndl3([string]$Machine.ip, 8193, 5, [ref]$handle)
    } catch [DllNotFoundException] { throw 'FANUC 32-bit FOCAS2 runtime Fwlib32.dll is not installed or not on PATH' }
    if ($code -ne 0) { throw "FOCAS connection failed: $code" }
    $connected = $true
    $raw = [ordered]@{ adapter = 'focas'; port = 8193; calls = [ordered]@{} }

    $status = New-Object Yingma.Cnc.ODBST2
    $statusCode = [Yingma.Cnc.Focas32]::cnc_statinfo2($handle, [ref]$status)
    $raw.calls.cnc_statinfo2 = [ordered]@{ code = $statusCode; aut = $status.aut; run = $status.run; motion = $status.motion; mstb = $status.mstb; emergency = $status.emergency; alarm = $status.alarm; edit = $status.edit; warning = $status.warning }
    if ($statusCode -ne 0) { throw "FOCAS cnc_statinfo2 failed: $statusCode" }

    $programInfo = New-Object Yingma.Cnc.ODBPROO8
    $programCode = [Yingma.Cnc.Focas32]::cnc_rdprgnumo8($handle, [ref]$programInfo)
    $raw.calls.cnc_rdprgnumo8 = [ordered]@{ code = $programCode; current = $programInfo.data; main = $programInfo.mdata }
    $pathBuilder = New-Object Text.StringBuilder 512
    $pathCode = [Yingma.Cnc.Focas32]::cnc_exeprgname2($handle, $pathBuilder)
    $programPath = if ($pathCode -eq 0) { $pathBuilder.ToString().Trim([char]0).Trim() } else { '' }
    $program = if ($programPath) { ($programPath -split '[\\/]')[-1] } elseif ($programInfo.mdata -gt 0) { 'O' + $programInfo.mdata } else { '' }
    $raw.calls.cnc_exeprgname2 = [ordered]@{ code = $pathCode; path = $programPath }

    $blockBuffer = New-Object byte[] 4096
    [uint16]$blockLength = $blockBuffer.Length
    [int16]$blockNumber = 0
    $blockCode = [Yingma.Cnc.Focas32]::cnc_rdexecprog($handle, [ref]$blockLength, [ref]$blockNumber, $blockBuffer)
    $raw.calls.cnc_rdexecprog = [ordered]@{ code = $blockCode; block = $blockNumber; text = if ($blockCode -eq 0) { Convert-YingmaBytesToText $blockBuffer[0..([Math]::Max(0, $blockLength - 1))] } else { $null } }

    $completed = Get-YingmaFocasMacro $handle 3901 $raw.calls
    $target = Get-YingmaFocasMacro $handle 3902 $raw.calls
    $timers = @{}
    foreach ($type in 0..3) {
      $timer = New-Object Yingma.Cnc.IODBTIME
      $timerCode = [Yingma.Cnc.Focas32]::cnc_rdtimer($handle, $type, [ref]$timer)
      $timers[$type] = [ordered]@{ code = $timerCode; minute = $timer.minute; msec = $timer.msec; seconds = if ($timerCode -eq 0) { ([double]$timer.minute * 60) + ([double]$timer.msec / 1000) } else { $null } }
    }
    $raw.calls.cnc_rdtimer = $timers
    $feed = New-Object Yingma.Cnc.ODBACT
    $feedCode = [Yingma.Cnc.Focas32]::cnc_actf($handle, [ref]$feed)
    $spindle = New-Object Yingma.Cnc.ODBACT
    $spindleCode = [Yingma.Cnc.Focas32]::cnc_acts($handle, [ref]$spindle)
    $raw.calls.cnc_actf = [ordered]@{ code = $feedCode; value = $feed.data }
    $raw.calls.cnc_acts = [ordered]@{ code = $spindleCode; value = $spindle.data }

    $execution = if ($status.run -in @(3, 4)) { 'running' } elseif ($status.run -eq 2) { 'paused' } else { 'stopped' }
    $previousExecution = [string](Get-DynamicProperty $Previous 'focasLastExecution')
    $storedCycleStart = Get-DynamicProperty $Previous 'focasCycleStartedAt'
    $cycleStart = $null
    if ($execution -in @('running', 'paused')) {
      $cycleStart = if ($storedCycleStart -and $previousExecution -in @('running', 'paused')) {
        Convert-IsoOffset $storedCycleStart
      } else {
        $observed
      }
    }
    $previousCapture = [string](Get-DynamicProperty $Previous 'programSourceCapturedFor')
    $sourceBytes = $null
    $sourceError = $null
    if ($program -and $program -ne $previousCapture) {
      try { $sourceBytes = Get-YingmaFocasSource $handle $(if ($programPath) { $programPath } else { $program }) ([int]$Config.maxProgramReadBytes) }
      catch { $sourceError = $_.Exception.Message }
    }
    $content = if ($sourceBytes) { Convert-YingmaBytesToText $sourceBytes } else { '' }
    $entry = [pscustomobject]@{ Name = $program; SizeBytes = if ($sourceBytes) { $sourceBytes.Length } else { 0 }; ModifiedAt = $null }
    $analysis = Get-ProgramAnalysis $entry $content ([string]$Config.camTimeZoneId)

    $snapshot = New-SnapshotBase $Machine $observed.ToString('o') $true $(if ($execution -eq 'running') { 'programming' } elseif ($program) { 'ready' } else { 'idle' }) $watch.ElapsedMilliseconds $null
    $snapshot.driver = 'focas'; $snapshot.manufacturer = 'FANUC'; $snapshot.model = '0i-MF Plus'; $snapshot.controller = 'FANUC 0i-MF Plus'
    $snapshot.currentProgram = if ($program) { $program } else { $null }
    $snapshot.programNumber = if ($programInfo.mdata -gt 0) { 'O' + $programInfo.mdata } else { $analysis.programNumber }
    $snapshot.programFingerprint = if ($sourceBytes) { Get-Hash $content } elseif ($program) { Get-Hash $program } else { $null }
    $snapshot.programSizeBytes = if ($sourceBytes) { $sourceBytes.Length } else { $null }
    $snapshot.programCount = if ($program) { 1 } else { 0 }; $snapshot.mainProgramCount = $snapshot.programCount
    $snapshot.sourcePart = $analysis.sourcePart; $snapshot.sourcePartPath = $analysis.sourcePartPath
    $snapshot.camProgrammedAt = $analysis.camProgrammedAt; $snapshot.estimatedDurationSeconds = $analysis.estimatedDurationSeconds
    $snapshot.operationCount = $analysis.operationCount; $snapshot.operations = @($analysis.operations); $snapshot.toolNumbers = @($analysis.toolNumbers)
    $snapshot.spindleRpm = if ($spindleCode -eq 0) { [int64]$spindle.data } else { $null }
    $snapshot.feedMmMin = if ($feedCode -eq 0) { [double]$feed.data } else { $null }
    $snapshot.completedParts = if ($null -ne $completed) { [int64][Math]::Round($completed) } else { $null }
    $snapshot.totalCompletedParts = $snapshot.completedParts
    $snapshot.targetParts = if ($null -ne $target) { [int64][Math]::Round($target) } else { $null }
    $snapshot.currentCycleSeconds = if ($cycleStart) { [Math]::Max(0, ($observed - $cycleStart).TotalSeconds) } else { $null }
    $snapshot.currentCuttingSeconds = if ($timers[2].code -eq 0) { $timers[2].seconds } else { $null }
    $snapshot.controllerBootCycleSeconds = if ($timers[1].code -eq 0) { $timers[1].seconds } else { $null }
    $snapshot.executionState = $execution; $snapshot.workSignal = 'controller_cycle'; $snapshot.telemetrySource = 'focas'
    $snapshot.runtimeObservedAt = $observed.ToString('o'); $snapshot.runtimeLatencyMs = [int]$watch.ElapsedMilliseconds; $snapshot.runtimeError = $sourceError
    $snapshot.discoveryStatus = 'native_read_ok'; $snapshot.discoveryConfidence = 100
    $snapshot.discoveredServices = @([pscustomobject]@{ port = 8193; name = 'fanuc-focas'; latencyMs = [int]$watch.ElapsedMilliseconds })
    $snapshot.capabilities = [pscustomobject]@{
      execution = [pscustomobject]@{ readable = $true; source = 'focas'; note = 'cnc_statinfo2 (read-only)' }
      programName = [pscustomobject]@{ readable = [bool]$program; source = 'focas'; note = 'cnc_exeprgname2/cnc_rdprgnumo8 (read-only)' }
      programSource = [pscustomobject]@{ readable = [bool]$sourceBytes; source = 'focas'; note = 'cnc_upstart4/cnc_upload4/cnc_upend4 (CNC-to-PC read)' }
      partCount = [pscustomobject]@{ readable = ($null -ne $completed); source = 'focas-macro'; note = 'Standard macro #3901/#3902; builder-specific PMC counters remain raw/unmapped' }
      duration = [pscustomobject]@{ readable = $true; source = 'focas'; note = 'cnc_rdtimer types 0-3' }
    }
    if ($sourceBytes) {
      $snapshot.programSource = $content.Substring(0, [Math]::Min($content.Length, [int]$Config.maxProgramSourceBytes))
      $snapshot.programSourceTruncated = $sourceBytes.Length -ge [int]$Config.maxProgramReadBytes -or $content.Length -gt [int]$Config.maxProgramSourceBytes
      $snapshot.programSourceSha256 = Get-Hash $content; $snapshot.programSourceCapturedAt = $observed.ToString('o')
    }
    $snapshot.rawTelemetry = [pscustomobject]$raw
    $nextState = if ($null -ne $Previous) { $Previous } else { [pscustomobject]@{} }
    Set-DynamicProperty $nextState 'focasLastExecution' $execution
    Set-DynamicProperty $nextState 'focasCycleStartedAt' $(if ($cycleStart) { $cycleStart.ToString('o') } else { $null })
    return [pscustomobject]@{ snapshot = $snapshot; state = $nextState }
  } catch {
    Reset-YingmaAutoDriver $Machine
    $snapshot = New-SnapshotBase $Machine $observed.ToString('o') $false 'error' $watch.ElapsedMilliseconds $_.Exception.Message
    $snapshot.driver = 'focas'; $snapshot.manufacturer = 'FANUC'; $snapshot.model = '0i-MF Plus'; $snapshot.controller = 'FANUC 0i-MF Plus'
    $snapshot.runtimeError = $_.Exception.Message; $snapshot.discoveryStatus = 'vendor_runtime_or_controller_error'
    $snapshot.discoveredServices = @([pscustomobject]@{ port = 8193; name = 'fanuc-focas'; latencyMs = [int]$watch.ElapsedMilliseconds })
    $snapshot.rawTelemetry = [pscustomobject]@{ adapter = 'focas'; error = $_.Exception.Message }
    return [pscustomobject]@{ snapshot = $snapshot; state = $Previous }
  } finally {
    $watch.Stop()
    if ($connected) { $null = [Yingma.Cnc.Focas32]::cnc_freelibhndl($handle) }
  }
}
