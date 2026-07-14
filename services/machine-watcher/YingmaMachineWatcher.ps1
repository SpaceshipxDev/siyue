#requires -Version 5.1

[CmdletBinding()]
param(
  [string]$ConfigPath = (Join-Path $PSScriptRoot 'config.json'),
  [switch]$Once,
  [switch]$TestRuntime,
  [switch]$DiscoverRuntime,
  [switch]$DeepDiscoverRuntime
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$WatcherVersion = '2.2.0'
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

function Get-ModbusRegisterCount {
  param([string]$DataType)
  switch ($DataType.ToLowerInvariant()) {
    'bool' { return 1 }
    'uint16' { return 1 }
    'int16' { return 1 }
    'uint32' { return 2 }
    'int32' { return 2 }
    'float32' { return 2 }
    'uint64' { return 4 }
    'int64' { return 4 }
    'float64' { return 4 }
    default { throw "Unsupported Modbus data type: $DataType" }
  }
}

function Read-ModbusRegisters {
  param(
    [IO.Stream]$Stream,
    [int]$TransactionId,
    [int]$UnitId,
    [int]$FunctionCode,
    [int]$Address,
    [int]$Quantity
  )
  if ($FunctionCode -ne 3 -and $FunctionCode -ne 4) { throw 'Only read-only Modbus functions 03 and 04 are allowed' }
  if ($Address -lt 0 -or $Address -gt 65535) { throw "Invalid Modbus address: $Address" }
  if ($Quantity -lt 1 -or $Quantity -gt 125 -or ($Address + $Quantity) -gt 65536) { throw "Invalid Modbus quantity: $Quantity" }

  [byte[]]$request = @(
    (($TransactionId -shr 8) -band 0xff), ($TransactionId -band 0xff),
    0x00, 0x00, 0x00, 0x06,
    ($UnitId -band 0xff), ($FunctionCode -band 0xff),
    (($Address -shr 8) -band 0xff), ($Address -band 0xff),
    (($Quantity -shr 8) -band 0xff), ($Quantity -band 0xff)
  )
  $Stream.Write($request, 0, $request.Length)
  $header = Read-ExactBytes $Stream 7
  $responseTransaction = ([int]$header[0] -shl 8) -bor [int]$header[1]
  if ($responseTransaction -ne $TransactionId) { throw 'Modbus transaction ID mismatch' }
  if ($header[2] -ne 0 -or $header[3] -ne 0) { throw 'Unexpected Modbus protocol ID' }
  $length = ([int]$header[4] -shl 8) -bor [int]$header[5]
  if ($length -lt 3 -or $length -gt 260) { throw 'Invalid Modbus response length' }
  $body = Read-ExactBytes $Stream ($length - 1)
  if (($body[0] -band 0x80) -ne 0) { throw "Modbus exception $($body[1]) at address $Address" }
  if ($body[0] -ne $FunctionCode) { throw 'Unexpected Modbus function code' }
  $byteCount = [int]$body[1]
  if ($byteCount -ne ($Quantity * 2) -or $body.Length -lt ($byteCount + 2)) { throw 'Unexpected Modbus register byte count' }

  $registers = New-Object UInt16[] $Quantity
  for ($index = 0; $index -lt $Quantity; $index++) {
    $offset = 2 + ($index * 2)
    $registers[$index] = [uint16]((([int]$body[$offset]) -shl 8) -bor [int]$body[$offset + 1])
  }
  return ,$registers
}

function Convert-ModbusRegisters {
  param([UInt16[]]$Registers, $Mapping)
  $dataType = if (Get-DynamicProperty $Mapping 'dataType') { [string]$Mapping.dataType } else { 'uint16' }
  $expected = Get-ModbusRegisterCount $dataType
  if ($Registers.Count -ne $expected) { throw "Expected $expected registers for $dataType" }

  [UInt16[]]$ordered = @($Registers)
  $wordOrder = if (Get-DynamicProperty $Mapping 'wordOrder') { [string]$Mapping.wordOrder } else { 'high-low' }
  if ($wordOrder -eq 'low-high') { [Array]::Reverse($ordered) }
  elseif ($wordOrder -ne 'high-low') { throw "Unsupported word order: $wordOrder" }

  $byteOrder = if (Get-DynamicProperty $Mapping 'byteOrder') { [string]$Mapping.byteOrder } else { 'big' }
  [byte[]]$networkBytes = New-Object byte[] ($ordered.Count * 2)
  for ($index = 0; $index -lt $ordered.Count; $index++) {
    $high = ([int]$ordered[$index] -shr 8) -band 0xff
    $low = [int]$ordered[$index] -band 0xff
    if ($byteOrder -eq 'big') {
      $networkBytes[$index * 2] = $high
      $networkBytes[($index * 2) + 1] = $low
    } elseif ($byteOrder -eq 'little') {
      $networkBytes[$index * 2] = $low
      $networkBytes[($index * 2) + 1] = $high
    } else { throw "Unsupported byte order: $byteOrder" }
  }

  [byte[]]$hostBytes = @($networkBytes)
  if ([BitConverter]::IsLittleEndian) { [Array]::Reverse($hostBytes) }
  switch ($dataType.ToLowerInvariant()) {
    'bool' { $value = [double]$ordered[0] }
    'uint16' { $value = [double]$ordered[0] }
    'int16' { $value = [double][BitConverter]::ToInt16($hostBytes, 0) }
    'uint32' { $value = [double][BitConverter]::ToUInt32($hostBytes, 0) }
    'int32' { $value = [double][BitConverter]::ToInt32($hostBytes, 0) }
    'float32' { $value = [double][BitConverter]::ToSingle($hostBytes, 0) }
    'uint64' { $value = [double][BitConverter]::ToUInt64($hostBytes, 0) }
    'int64' { $value = [double][BitConverter]::ToInt64($hostBytes, 0) }
    'float64' { $value = [double][BitConverter]::ToDouble($hostBytes, 0) }
  }
  if ([double]::IsNaN($value) -or [double]::IsInfinity($value)) { throw 'Modbus value is not finite' }
  $scale = if ($null -ne (Get-DynamicProperty $Mapping 'scale')) { [double]$Mapping.scale } else { 1.0 }
  $offsetValue = if ($null -ne (Get-DynamicProperty $Mapping 'offset')) { [double]$Mapping.offset } else { 0.0 }
  return ($value * $scale) + $offsetValue
}

function Get-LynucRuntimeTelemetry {
  param([string]$HostName, $Runtime)
  $client = New-Object Net.Sockets.TcpClient
  $started = [Diagnostics.Stopwatch]::StartNew()
  $connected = $false
  try {
    $port = if (Get-DynamicProperty $Runtime 'port') { [int]$Runtime.port } else { 502 }
    $pending = $client.BeginConnect($HostName, $port, $null, $null)
    if (-not $pending.AsyncWaitHandle.WaitOne(2000)) { throw 'Modbus connection timed out' }
    $client.EndConnect($pending)
    $connected = $true
    $stream = $client.GetStream()
    $stream.ReadTimeout = 2000
    $stream.WriteTimeout = 2000

    $verified = [bool](Get-DynamicProperty $Runtime 'verified')
    $fields = Get-DynamicProperty $Runtime 'fields'
    if (-not $verified -or $null -eq $fields) {
      $started.Stop()
      return [pscustomobject]@{
        transportAvailable = $true; exact = $false; latencyMs = $started.ElapsedMilliseconds
        values = [pscustomobject]@{}; error = 'Modbus TCP is reachable; verified LYNUC register mapping is not configured'
      }
    }

    $unit = if (Get-DynamicProperty $Runtime 'unitId') { [int]$Runtime.unitId } else { 1 }
    $values = [pscustomobject]@{}
    $transaction = 1
    foreach ($property in $fields.PSObject.Properties) {
      $mapping = $property.Value
      if ($null -eq (Get-DynamicProperty $mapping 'address')) { throw "Runtime field $($property.Name) has no address" }
      $dataType = if (Get-DynamicProperty $mapping 'dataType') { [string]$mapping.dataType } else { 'uint16' }
      $quantity = Get-ModbusRegisterCount $dataType
      $functionCode = if (Get-DynamicProperty $mapping 'functionCode') { [int]$mapping.functionCode } else { 3 }
      $registers = Read-ModbusRegisters $stream $transaction $unit $functionCode ([int]$mapping.address) $quantity
      $value = Convert-ModbusRegisters $registers $mapping
      $values | Add-Member -NotePropertyName $property.Name -NotePropertyValue $value -Force
      $transaction++
    }
    $started.Stop()
    return [pscustomobject]@{ transportAvailable = $true; exact = $true; latencyMs = $started.ElapsedMilliseconds; values = $values; error = $null }
  } catch {
    $started.Stop()
    return [pscustomobject]@{
      transportAvailable = $connected; exact = $false; latencyMs = $started.ElapsedMilliseconds
      values = [pscustomobject]@{}; error = $_.Exception.Message
    }
  } finally {
    $client.Dispose()
  }
}

function Get-RuntimeValue {
  param($Values, [string]$Name)
  $value = Get-DynamicProperty $Values $Name
  if ($null -eq $value) { return $null }
  return [double]$value
}

function Get-RuntimeBoolean {
  param($Values, $Runtime, [string]$Name)
  $value = Get-RuntimeValue $Values $Name
  if ($null -eq $value) { return $null }
  $mapping = Get-DynamicProperty (Get-DynamicProperty $Runtime 'fields') $Name
  $mask = if ($null -ne (Get-DynamicProperty $mapping 'bitMask')) { [int64]$mapping.bitMask } else { 65535 }
  $activeValue = if ($null -ne (Get-DynamicProperty $mapping 'activeValue')) { [int64]$mapping.activeValue } else { 1 }
  return (([int64]$value -band $mask) -eq $activeValue)
}

function Test-TcpPort {
  param([string]$HostName, [int]$Port, [int]$TimeoutMs = 600)
  $client = New-Object Net.Sockets.TcpClient
  $started = [Diagnostics.Stopwatch]::StartNew()
  try {
    $pending = $client.BeginConnect($HostName, $Port, $null, $null)
    if (-not $pending.AsyncWaitHandle.WaitOne($TimeoutMs)) { return [pscustomobject]@{ open = $false; latencyMs = $started.ElapsedMilliseconds } }
    $client.EndConnect($pending)
    return [pscustomobject]@{ open = $true; latencyMs = $started.ElapsedMilliseconds }
  } catch {
    return [pscustomobject]@{ open = $false; latencyMs = $started.ElapsedMilliseconds }
  } finally {
    $started.Stop()
    $client.Dispose()
  }
}

function Get-LynucServiceInventory {
  param([string]$HostName, [int]$ConfiguredModbusPort = 502)
  $ports = @(
    [pscustomobject]@{ port = 21; name = 'ftp' },
    [pscustomobject]@{ port = 22; name = 'ssh' },
    [pscustomobject]@{ port = 80; name = 'http' },
    [pscustomobject]@{ port = 443; name = 'https' },
    [pscustomobject]@{ port = $ConfiguredModbusPort; name = 'modbus-tcp' },
    [pscustomobject]@{ port = 5900; name = 'vnc' },
    [pscustomobject]@{ port = 5901; name = 'vnc-1' }
  )
  $seen = @{}
  $open = @()
  foreach ($service in $ports) {
    if ($seen.ContainsKey([int]$service.port)) { continue }
    $seen[[int]$service.port] = $true
    $probe = Test-TcpPort $HostName ([int]$service.port)
    if ($probe.open) { $open += [pscustomobject]@{ port = [int]$service.port; name = [string]$service.name; latencyMs = [int]$probe.latencyMs } }
  }
  return @($open)
}

function New-AutoRuntimeProfile {
  param([int]$Port, [int]$UnitId, [int]$FunctionCode, [int]$AddressOffset, [string]$WordOrder, [string]$ByteOrder)
  $field = {
    param([int]$MacroNumber, [string]$DataType)
    return [pscustomobject]@{
      address = $MacroNumber + $AddressOffset
      functionCode = $FunctionCode
      dataType = $DataType
      wordOrder = $WordOrder
      byteOrder = $ByteOrder
      macroNumber = $MacroNumber
    }
  }
  return [pscustomobject]@{
    port = $Port
    unitId = $UnitId
    verified = $true
    autoDiscovered = $true
    profile = "unit=$UnitId/fn=$FunctionCode/offset=$AddressOffset/words=$WordOrder/bytes=$ByteOrder"
    fields = [pscustomobject]@{
      currentCycleMs = & $field 33564 'float64'
      currentCuttingMs = & $field 33565 'float64'
      controllerBootCycleMs = & $field 33868 'float64'
      completedParts = & $field 33869 'int32'
      totalCompletedParts = & $field 33870 'int32'
      targetParts = & $field 33871 'int32'
    }
  }
}

function Get-RuntimePlausibilityScore {
  param($Values)
  $cycle = Get-RuntimeValue $Values 'currentCycleMs'
  $cutting = Get-RuntimeValue $Values 'currentCuttingMs'
  $boot = Get-RuntimeValue $Values 'controllerBootCycleMs'
  $completed = Get-RuntimeValue $Values 'completedParts'
  $total = Get-RuntimeValue $Values 'totalCompletedParts'
  $target = Get-RuntimeValue $Values 'targetParts'
  if ($null -eq $cycle -or $null -eq $cutting -or $null -eq $boot -or
      $null -eq $completed -or $null -eq $total -or $null -eq $target) { return -100 }

  $score = 0
  $maxMs = 20.0 * 365.0 * 24.0 * 3600.0 * 1000.0
  if ($cycle -ge 0 -and $cycle -le $maxMs) { $score += 1 } else { return -100 }
  if ($cutting -ge 0 -and $cutting -le $maxMs) { $score += 1 } else { return -100 }
  if ($boot -ge 0 -and $boot -le $maxMs) { $score += 1 } else { return -100 }
  if ($cutting -le ($cycle + 2000)) { $score += 2 }
  if ($cycle -le ($boot + 2000)) { $score += 2 }
  if ($boot -ge 1000) { $score += 2 }

  foreach ($count in @($completed, $total, $target)) {
    if ($count -lt 0 -or $count -gt 100000000 -or [Math]::Abs($count - [Math]::Round($count)) -gt 0.0001) { return -100 }
    $score += 1
  }
  if ($total -ge $completed) { $score += 2 }
  if ($total -gt 0) { $score += 2 }
  return $score
}

function Find-LynucRuntimeCandidate {
  param([string]$HostName, [int]$Port = 502)
  $transportProbe = Get-LynucRuntimeTelemetry $HostName ([pscustomobject]@{ port = $Port; unitId = 1; verified = $false; fields = [pscustomobject]@{} })
  if (-not $transportProbe.transportAvailable) {
    return [pscustomobject]@{ candidate = $null; candidateCount = 0; requests = 0; bestScore = $null; ambiguous = $false; transportAvailable = $false; phasesTried = 0 }
  }
  # Try the overwhelmingly common unit/function first and stop as soon as it
  # produces one unambiguous candidate. Fallbacks remain read-only and bounded.
  $phases = @(
    [pscustomobject]@{ unitId = 1; functionCode = 3 },
    [pscustomobject]@{ unitId = 1; functionCode = 4 },
    [pscustomobject]@{ unitId = 255; functionCode = 3 },
    [pscustomobject]@{ unitId = 255; functionCode = 4 },
    [pscustomobject]@{ unitId = 0; functionCode = 3 },
    [pscustomobject]@{ unitId = 0; functionCode = 4 }
  )

  $requests = 0
  $phasesTried = 0
  foreach ($phase in $phases) {
    $phasesTried++
    $candidates = @()
    foreach ($offset in @(0, -1)) {
      foreach ($wordOrder in @('high-low', 'low-high')) {
        foreach ($byteOrder in @('big', 'little')) {
          $profile = New-AutoRuntimeProfile $Port ([int]$phase.unitId) ([int]$phase.functionCode) $offset $wordOrder $byteOrder
          $result = Get-LynucRuntimeTelemetry $HostName $profile
          # Six is a conservative ceiling. A rejected profile normally stops
          # at its first failed field and therefore sends fewer requests.
          $requests += 6
          if ($result.exact) {
            $score = Get-RuntimePlausibilityScore $result.values
            if ($score -ge 10) {
              $candidates += [pscustomobject]@{ runtime = $profile; values = $result.values; score = $score; latencyMs = $result.latencyMs }
            }
          }
          Start-Sleep -Milliseconds 75
        }
      }
    }

    $ordered = @($candidates | Sort-Object score -Descending)
    $winner = if ($ordered.Count -gt 0) { $ordered[0] } else { $null }
    $unique = $null -ne $winner -and ($ordered.Count -eq 1 -or [int]$winner.score -gt [int]$ordered[1].score)
    if ($null -ne $winner) {
      return [pscustomobject]@{
        candidate = if ($unique) { $winner } else { $null }
        candidateCount = $ordered.Count
        requests = $requests
        bestScore = [int]$winner.score
        ambiguous = -not $unique
        transportAvailable = $true
        phasesTried = $phasesTried
      }
    }
  }

  return [pscustomobject]@{
    candidate = $null; candidateCount = 0; requests = $requests; bestScore = $null
    ambiguous = $false; transportAvailable = $true; phasesTried = $phasesTried
  }
}

function Read-ModbusRegisterSurvey {
  param(
    [string]$HostName,
    [int]$Port,
    [int]$UnitId,
    [int]$FunctionCode,
    [int]$ThrottleMs = 50,
    [bool]$Exhaustive = $false
  )
  $client = New-Object Net.Sockets.TcpClient
  $registers = @{}
  $requests = 0
  $readableBlocks = 0
  $failedBlocks = 0
  $nonZeroRegisters = 0
  $startedAt = [DateTimeOffset]::UtcNow
  $started = [Diagnostics.Stopwatch]::StartNew()
  try {
    $pending = $client.BeginConnect($HostName, $Port, $null, $null)
    if (-not $pending.AsyncWaitHandle.WaitOne(2000)) { throw 'Modbus connection timed out' }
    $client.EndConnect($pending)
    $stream = $client.GetStream()
    $stream.ReadTimeout = 1200
    $stream.WriteTimeout = 1200
    $transaction = 1
    $consecutiveFailures = 0
    for ($address = 0; $address -lt 65536; $address += 120) {
      $quantity = [Math]::Min(120, 65536 - $address)
      $requests++
      try {
        $block = Read-ModbusRegisters $stream $transaction $UnitId $FunctionCode $address $quantity
        $readableBlocks++
        $consecutiveFailures = 0
        for ($index = 0; $index -lt $block.Count; $index++) {
          $value = [uint16]$block[$index]
          $registers[$address + $index] = $value
          if ($value -ne 0) { $nonZeroRegisters++ }
        }
      } catch {
        $failedBlocks++
        $consecutiveFailures++
        if (-not $Exhaustive -and $readableBlocks -eq 0 -and $consecutiveFailures -ge 16) { break }
      }
      $transaction = if ($transaction -ge 65535) { 1 } else { $transaction + 1 }
      if ($ThrottleMs -gt 0) { Start-Sleep -Milliseconds $ThrottleMs }
    }
    $started.Stop()
    return [pscustomobject]@{
      transportAvailable = $true; registers = $registers; requests = $requests
      readableBlocks = $readableBlocks; failedBlocks = $failedBlocks
      nonZeroRegisters = $nonZeroRegisters; startedAt = $startedAt.ToString('o')
      elapsedMs = [int64]$started.ElapsedMilliseconds; error = $null
    }
  } catch {
    $started.Stop()
    return [pscustomobject]@{
      transportAvailable = $false; registers = $registers; requests = $requests
      readableBlocks = $readableBlocks; failedBlocks = $failedBlocks
      nonZeroRegisters = $nonZeroRegisters; startedAt = $startedAt.ToString('o')
      elapsedMs = [int64]$started.ElapsedMilliseconds; error = $_.Exception.Message
    }
  } finally {
    $client.Dispose()
  }
}

function Get-SurveyTypedValue {
  param($Registers, [int]$Address, [string]$DataType, [string]$WordOrder, [string]$ByteOrder)
  try {
    $quantity = Get-ModbusRegisterCount $DataType
    if ($Address -lt 0 -or ($Address + $quantity) -gt 65536) { return $null }
    [UInt16[]]$window = New-Object UInt16[] $quantity
    for ($index = 0; $index -lt $quantity; $index++) {
      $key = $Address + $index
      if (-not $Registers.ContainsKey($key)) { return $null }
      $window[$index] = [uint16]$Registers[$key]
    }
    return Convert-ModbusRegisters $window ([pscustomobject]@{
      dataType = $DataType; wordOrder = $WordOrder; byteOrder = $ByteOrder
    })
  } catch { return $null }
}

function New-DeepRuntimeProfile {
  param(
    [int]$Port, [int]$UnitId, [int]$FunctionCode,
    [int]$CycleAddress, [int]$CuttingAddress, [int]$BootAddress,
    [int]$CompletedAddress, [int]$TotalAddress, [int]$TargetAddress,
    [string]$WordOrder, [string]$ByteOrder, [string]$Template
  )
  $field = {
    param([int]$Address, [string]$DataType, [int]$MacroNumber)
    [pscustomobject]@{
      address = $Address; functionCode = $FunctionCode; dataType = $DataType
      wordOrder = $WordOrder; byteOrder = $ByteOrder; macroNumber = $MacroNumber
    }
  }
  return [pscustomobject]@{
    port = $Port; unitId = $UnitId; verified = $true; autoDiscovered = $true
    deepDiscovered = $true
    profile = "deep/$Template/unit=$UnitId/fn=$FunctionCode/base=$CycleAddress/words=$WordOrder/bytes=$ByteOrder"
    fields = [pscustomobject]@{
      currentCycleMs = & $field $CycleAddress 'float64' 33564
      currentCuttingMs = & $field $CuttingAddress 'float64' 33565
      controllerBootCycleMs = & $field $BootAddress 'float64' 33868
      completedParts = & $field $CompletedAddress 'int32' 33869
      totalCompletedParts = & $field $TotalAddress 'int32' 33870
      targetParts = & $field $TargetAddress 'int32' 33871
    }
  }
}

function Get-DeepRuntimeCandidates {
  param($BeforeSurvey, $AfterSurvey, [int]$Port, [int]$UnitId, [int]$FunctionCode)
  $before = $BeforeSurvey.registers
  $after = $AfterSurvey.registers
  $elapsedMs = [Math]::Max(1, ((Convert-IsoOffset $AfterSurvey.startedAt) - (Convert-IsoOffset $BeforeSurvey.startedAt)).TotalMilliseconds)
  $candidates = @()

  foreach ($wordOrder in @('high-low', 'low-high')) {
    foreach ($byteOrder in @('big', 'little')) {
      for ($base = 0; $base -le 65532; $base++) {
        $beforeCycle = Get-SurveyTypedValue $before $base 'float64' $wordOrder $byteOrder
        $afterCycle = Get-SurveyTypedValue $after $base 'float64' $wordOrder $byteOrder
        if ($null -eq $beforeCycle -or $null -eq $afterCycle) { continue }
        if ($beforeCycle -lt 0 -or $afterCycle -lt 1000 -or $beforeCycle -gt (20.0 * 365 * 24 * 3600 * 1000)) { continue }
        $cycleDelta = if ($afterCycle -ge $beforeCycle) { $afterCycle - $beforeCycle } else { $afterCycle }
        # A full survey takes time; allow the register's own movement to be
        # compared despite the two reads occurring at different scan offsets.
        if ($cycleDelta -le 0 -or $cycleDelta -gt ($elapsedMs + 120000)) { continue }

        $templates = @(
          [pscustomobject]@{ name = 'packed'; cutting = $base + 4; boot = $base + 8; completed = $base + 12; total = $base + 14; target = $base + 16; bonus = 6 },
          [pscustomobject]@{ name = 'macro-slot-1'; cutting = $base + 1; boot = $base + 304; completed = $base + 305; total = $base + 306; target = $base + 307; bonus = 3 },
          [pscustomobject]@{ name = 'macro-slot-2'; cutting = $base + 2; boot = $base + 608; completed = $base + 610; total = $base + 612; target = $base + 614; bonus = 4 },
          [pscustomobject]@{ name = 'macro-slot-4'; cutting = $base + 4; boot = $base + 1216; completed = $base + 1220; total = $base + 1224; target = $base + 1228; bonus = 5 }
        )
        foreach ($template in $templates) {
          if ($template.target -gt 65534) { continue }
          $values = [pscustomobject]@{
            currentCycleMs = $afterCycle
            currentCuttingMs = Get-SurveyTypedValue $after $template.cutting 'float64' $wordOrder $byteOrder
            controllerBootCycleMs = Get-SurveyTypedValue $after $template.boot 'float64' $wordOrder $byteOrder
            completedParts = Get-SurveyTypedValue $after $template.completed 'int32' $wordOrder $byteOrder
            totalCompletedParts = Get-SurveyTypedValue $after $template.total 'int32' $wordOrder $byteOrder
            targetParts = Get-SurveyTypedValue $after $template.target 'int32' $wordOrder $byteOrder
          }
          $plausibility = Get-RuntimePlausibilityScore $values
          if ($plausibility -lt 10 -or [double]$values.controllerBootCycleMs -lt 1000 -or
              [double]$values.currentCycleMs -gt ([double]$values.controllerBootCycleMs + 2000) -or
              [double]$values.totalCompletedParts -le 0 -or
              [double]$values.totalCompletedParts -lt [double]$values.completedParts) { continue }

          $motionScore = 0
          foreach ($timer in @(
            [pscustomobject]@{ address = $base; after = [double]$values.currentCycleMs },
            [pscustomobject]@{ address = [int]$template.cutting; after = [double]$values.currentCuttingMs },
            [pscustomobject]@{ address = [int]$template.boot; after = [double]$values.controllerBootCycleMs }
          )) {
            $old = Get-SurveyTypedValue $before $timer.address 'float64' $wordOrder $byteOrder
            if ($null -eq $old) { continue }
            $delta = if ($timer.after -ge $old) { $timer.after - $old } else { $timer.after }
            if ($delta -gt 0 -and $delta -le ($elapsedMs + 120000)) { $motionScore += 3 }
          }
          if ($motionScore -lt 3) { continue }

          $runtime = New-DeepRuntimeProfile $Port $UnitId $FunctionCode `
            $base $template.cutting $template.boot $template.completed $template.total $template.target `
            $wordOrder $byteOrder $template.name
          $candidates += [pscustomobject]@{
            runtime = $runtime; values = $values
            score = [int]$plausibility + $motionScore + [int]$template.bonus
            elapsedMs = [int64]$elapsedMs
          }
        }
      }
    }
  }
  return @($candidates | Sort-Object score -Descending)
}

function Find-DeepLynucRuntimeCandidate {
  param([string]$HostName, [int]$Port = 502)
  $phases = @(
    [pscustomobject]@{ unitId = 1; functionCode = 3 },
    [pscustomobject]@{ unitId = 1; functionCode = 4 },
    [pscustomobject]@{ unitId = 255; functionCode = 3 },
    [pscustomobject]@{ unitId = 255; functionCode = 4 },
    [pscustomobject]@{ unitId = 0; functionCode = 3 },
    [pscustomobject]@{ unitId = 0; functionCode = 4 }
  )
  $requests = 0
  $summaries = @()
  foreach ($phase in $phases) {
    $label = "unit=$($phase.unitId)/fn=$($phase.functionCode)"
    Write-WatcherLog "$HostName deep survey $label first pass"
    $first = Read-ModbusRegisterSurvey $HostName $Port $phase.unitId $phase.functionCode 50 ($phase.unitId -eq 1 -and $phase.functionCode -eq 3)
    $requests += [int]$first.requests
    $summary = [pscustomobject]@{
      profile = $label; firstRequests = [int]$first.requests; secondRequests = 0
      readableBlocks = [int]$first.readableBlocks; failedBlocks = [int]$first.failedBlocks
      nonZeroRegisters = [int]$first.nonZeroRegisters; candidates = 0; bestScore = $null
    }
    if (-not $first.transportAvailable -or $first.readableBlocks -eq 0 -or $first.nonZeroRegisters -eq 0) {
      $summaries += $summary
      continue
    }

    Write-WatcherLog "$HostName deep survey $label second pass"
    $second = Read-ModbusRegisterSurvey $HostName $Port $phase.unitId $phase.functionCode 50 $false
    $requests += [int]$second.requests
    $summary.secondRequests = [int]$second.requests
    if (-not $second.transportAvailable -or $second.readableBlocks -eq 0) {
      $summaries += $summary
      continue
    }
    $candidates = @(Get-DeepRuntimeCandidates $first $second $Port $phase.unitId $phase.functionCode)
    $summary.candidates = $candidates.Count
    if ($candidates.Count -gt 0) { $summary.bestScore = [int]$candidates[0].score }
    $summaries += $summary
    if ($candidates.Count -gt 0) {
      $winner = $candidates[0]
      $unique = $candidates.Count -eq 1 -or ([int]$winner.score - [int]$candidates[1].score) -ge 3
      return [pscustomobject]@{
        candidate = if ($unique) { $winner } else { $null }
        candidateCount = $candidates.Count; requests = $requests
        bestScore = [int]$winner.score; ambiguous = -not $unique; surveys = $summaries
      }
    }
  }
  return [pscustomobject]@{
    candidate = $null; candidateCount = 0; requests = $requests
    bestScore = $null; ambiguous = $false; surveys = $summaries
  }
}

function Get-AutoRuntimeEvidence {
  param($Previous, $Values, [DateTimeOffset]$Observed)
  $samples = [int](Get-DynamicProperty $Previous 'autoRuntimeSamples') + 1
  $validSamples = [int](Get-DynamicProperty $Previous 'autoRuntimeValidSamples')
  $movingSamples = [int](Get-DynamicProperty $Previous 'autoRuntimeMovingSamples')
  $failures = [int](Get-DynamicProperty $Previous 'autoRuntimeFailures')
  $score = Get-RuntimePlausibilityScore $Values
  $valid = $score -ge 10
  if ($valid) { $validSamples++ } else { $failures++ }

  $previousValues = Get-DynamicProperty $Previous 'autoRuntimeLastValues'
  $previousObserved = Get-DynamicProperty $Previous 'observedAt'
  if ($valid -and $null -ne $previousValues -and $previousObserved) {
    $elapsedMs = [Math]::Max(0, ($Observed - (Convert-IsoOffset $previousObserved)).TotalMilliseconds)
    $beforeCutting = Get-RuntimeValue $previousValues 'currentCuttingMs'
    $afterCutting = Get-RuntimeValue $Values 'currentCuttingMs'
    if ($null -ne $beforeCutting -and $null -ne $afterCutting) {
      $delta = if ($afterCutting -ge $beforeCutting) { $afterCutting - $beforeCutting } else { $afterCutting }
      if ($delta -gt 0 -and $delta -le ($elapsedMs + 2500)) { $movingSamples++ }
      elseif ($delta -gt ($elapsedMs + 2500)) { $valid = $false; $failures++ }
    }
  }

  $promoted = $validSamples -ge 8 -and $failures -eq 0 -and ($movingSamples -ge 2 -or $validSamples -ge 20)
  $motionBonus = if ($movingSamples -gt 0) { 4 } else { 0 }
  $confidence = [Math]::Min(99, [int][Math]::Floor(($validSamples / 20.0) * 95.0) + $motionBonus)
  return [pscustomobject]@{
    samples = $samples; validSamples = $validSamples; movingSamples = $movingSamples
    failures = $failures; promoted = $promoted; confidence = $confidence; score = $score; valid = $valid
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
  if ($null -eq $State) { $State = [pscustomobject]@{} }
  foreach ($name in @(
    'lastAutoDiscoveryAt', 'discoveredServices', 'autoDiscoveryRequests', 'autoDiscoveryCandidateCount', 'autoDiscoveryBestScore',
    'autoRuntime', 'autoRuntimeSamples', 'autoRuntimeValidSamples', 'autoRuntimeMovingSamples',
    'autoRuntimeFailures', 'autoRuntimeLastValues', 'autoRuntimePromoted'
  )) {
    $stored = Get-DynamicProperty $Previous $name
    if ($null -ne $stored) { Set-DynamicProperty $State $name $stored }
  }
  $executionState = 'unknown'
  $workSignal = 'unavailable'
  $workActive = $false
  $runtime = Get-DynamicProperty $Machine 'runtime'
  $runtimeTrusted = $null -ne $runtime -and [bool](Get-DynamicProperty $runtime 'verified')
  $autoCandidate = $false
  if (-not $runtimeTrusted) {
    $legacy = Get-DynamicProperty $Machine 'runSignal'
    if ($null -ne $legacy) {
      $runtime = [pscustomobject]@{
        port = if (Get-DynamicProperty $legacy 'port') { [int]$legacy.port } else { 502 }
        unitId = if (Get-DynamicProperty $legacy 'unitId') { [int]$legacy.unitId } else { 1 }
        verified = $true
        fields = [pscustomobject]@{ cycleRunning = $legacy }
      }
      $runtimeTrusted = $true
    } else {
      $storedAutoRuntime = Get-DynamicProperty $Previous 'autoRuntime'
      if ($null -ne $storedAutoRuntime) {
        $runtime = $storedAutoRuntime
        $autoCandidate = $true
      } else {
        $lastDiscovery = Get-DynamicProperty $Previous 'lastAutoDiscoveryAt'
        $discoveryDue = -not $lastDiscovery -or ($observed - (Convert-IsoOffset $lastDiscovery)).TotalHours -ge 6
        if ($discoveryDue) {
          Write-WatcherLog "$($Machine.name) bounded LYNUC runtime discovery started (48 requests per profile family; 288 conservative maximum)"
          $discoveryPort = if ($null -ne $runtime -and (Get-DynamicProperty $runtime 'port')) { [int]$runtime.port } else { 502 }
          $services = @(Get-LynucServiceInventory ([string]$Machine.ip) $discoveryPort)
          Set-DynamicProperty $State 'discoveredServices' $services
          $discovery = Find-LynucRuntimeCandidate ([string]$Machine.ip) $discoveryPort
          Set-DynamicProperty $State 'lastAutoDiscoveryAt' $observed.ToString('o')
          Set-DynamicProperty $State 'autoDiscoveryRequests' ([int]$discovery.requests)
          Set-DynamicProperty $State 'autoDiscoveryCandidateCount' ([int]$discovery.candidateCount)
          Set-DynamicProperty $State 'autoDiscoveryBestScore' $discovery.bestScore
          if ($null -ne $discovery.candidate) {
            $runtime = $discovery.candidate.runtime
            $autoCandidate = $true
            Set-DynamicProperty $State 'autoRuntime' $runtime
            Write-WatcherLog "$($Machine.name) candidate $($runtime.profile) selected for temporal validation"
          } else {
            $runtime = [pscustomobject]@{ port = 502; unitId = 1; verified = $false; fields = [pscustomobject]@{} }
          }
        } else {
          $runtime = [pscustomobject]@{ port = 502; unitId = 1; verified = $false; fields = [pscustomobject]@{} }
        }
      }
    }
  }
  $runtimeResult = Get-LynucRuntimeTelemetry ([string]$Machine.ip) $runtime
  if ($autoCandidate -and $runtimeResult.exact) {
    $evidence = Get-AutoRuntimeEvidence $Previous $runtimeResult.values $observed
    Set-DynamicProperty $State 'autoRuntimeSamples' ([int]$evidence.samples)
    Set-DynamicProperty $State 'autoRuntimeValidSamples' ([int]$evidence.validSamples)
    Set-DynamicProperty $State 'autoRuntimeMovingSamples' ([int]$evidence.movingSamples)
    Set-DynamicProperty $State 'autoRuntimeFailures' ([int]$evidence.failures)
    Set-DynamicProperty $State 'autoRuntimeLastValues' $runtimeResult.values
    $wasPromoted = [bool](Get-DynamicProperty $Previous 'autoRuntimePromoted')
    $runtimeTrusted = $wasPromoted -or [bool]$evidence.promoted
    Set-DynamicProperty $State 'autoRuntimePromoted' $runtimeTrusted
    $Snapshot.discoveryConfidence = if ($runtimeTrusted) { [Math]::Max(95, [int]$evidence.confidence) } else { [int]$evidence.confidence }
    $Snapshot.discoveryStatus = if ($runtimeTrusted) { 'auto_locked' } else { 'validating' }
    if (-not $runtimeTrusted) {
      $runtimeResult.error = "Candidate validating: $($evidence.validSamples)/8 valid samples, $($evidence.movingSamples)/2 moving samples"
    }
    if ([int]$evidence.failures -ge 3) {
      Set-DynamicProperty $State 'autoRuntime' $null
      Set-DynamicProperty $State 'autoRuntimePromoted' $false
      $runtimeTrusted = $false
      $Snapshot.discoveryStatus = 'candidate_rejected'
      $runtimeResult.error = 'Automatic candidate rejected after temporal validation failures; discovery will retry later'
    }
  } elseif ($autoCandidate) {
    $failures = [int](Get-DynamicProperty $Previous 'autoRuntimeFailures') + 1
    Set-DynamicProperty $State 'autoRuntimeFailures' $failures
    $Snapshot.discoveryStatus = 'candidate_unreadable'
    $Snapshot.discoveryConfidence = 0
    if ($failures -ge 3) { Set-DynamicProperty $State 'autoRuntime' $null }
  } else {
    $Snapshot.discoveryStatus = if ($runtimeResult.transportAvailable) { 'mapping_not_found' } else { 'modbus_unreachable' }
    $Snapshot.discoveryConfidence = 0
  }
  if ($runtimeResult.transportAvailable -and -not $Snapshot.connected) {
    $Snapshot.connected = $true
    if ($Snapshot.state -eq 'offline') { $Snapshot.state = 'unknown' }
  }
  $Snapshot.runtimeLatencyMs = [int]$runtimeResult.latencyMs
  $Snapshot.runtimeError = $runtimeResult.error
  $Snapshot.runtimeObservedAt = if ($runtimeResult.transportAvailable) { $observed.ToString('o') } else { $null }
  $Snapshot.discoveredServices = @((Get-DynamicProperty $State 'discoveredServices'))

  $currentCycleSeconds = $null
  $currentCuttingSeconds = $null
  $controllerBootCycleSeconds = $null
  if ($runtimeResult.exact -and $runtimeTrusted) {
    $cycleMs = Get-RuntimeValue $runtimeResult.values 'currentCycleMs'
    $cuttingMs = Get-RuntimeValue $runtimeResult.values 'currentCuttingMs'
    $bootCycleMs = Get-RuntimeValue $runtimeResult.values 'controllerBootCycleMs'
    if ($null -ne $cycleMs -and $cycleMs -ge 0) { $currentCycleSeconds = $cycleMs / 1000.0 }
    if ($null -ne $cuttingMs -and $cuttingMs -ge 0) { $currentCuttingSeconds = $cuttingMs / 1000.0 }
    if ($null -ne $bootCycleMs -and $bootCycleMs -ge 0) { $controllerBootCycleSeconds = $bootCycleMs / 1000.0 }

    $completed = Get-RuntimeValue $runtimeResult.values 'completedParts'
    $totalCompleted = Get-RuntimeValue $runtimeResult.values 'totalCompletedParts'
    $target = Get-RuntimeValue $runtimeResult.values 'targetParts'
    if ($null -ne $cycleMs -or $null -ne $cuttingMs -or $null -ne $bootCycleMs -or
        $null -ne $completed -or $null -ne $totalCompleted -or $null -ne $target) {
      $Snapshot.telemetrySource = if ($autoCandidate) { 'controller_macro_auto' } else { 'controller_macro' }
    }
    if ($null -ne $completed -and $completed -ge 0) { $Snapshot.completedParts = [int64][Math]::Round($completed) }
    if ($null -ne $totalCompleted -and $totalCompleted -ge 0) { $Snapshot.totalCompletedParts = [int64][Math]::Round($totalCompleted) }
    if ($null -ne $target -and $target -ge 0) { $Snapshot.targetParts = [int64][Math]::Round($target) }

    $cycleRunning = Get-RuntimeBoolean $runtimeResult.values $runtime 'cycleRunning'
    $cyclePaused = Get-RuntimeBoolean $runtimeResult.values $runtime 'cyclePaused'
    if ($null -ne $cycleRunning) {
      $workSignal = 'controller_cycle'
      $workActive = [bool]$cycleRunning -and -not [bool]$cyclePaused
      $executionState = if ([bool]$cyclePaused) { 'paused' } elseif ([bool]$cycleRunning) { 'running' } else { 'stopped' }
    }
  }
  $Snapshot.currentCycleSeconds = $currentCycleSeconds
  $Snapshot.currentCuttingSeconds = $currentCuttingSeconds
  $Snapshot.controllerBootCycleSeconds = $controllerBootCycleSeconds

  # If no discrete CycleStart bit is mapped, the controller's own #33565
  # movement is authoritative evidence that metal-cutting time is advancing.
  if ($workSignal -eq 'unavailable' -and $null -ne $currentCuttingSeconds) {
    $previousCutting = Get-DynamicProperty $Previous 'currentCuttingSeconds'
    $previousObserved = Get-DynamicProperty $Previous 'observedAt'
    if ($null -ne $previousCutting -and $previousObserved) {
      $elapsed = ($observed - (Convert-IsoOffset $previousObserved)).TotalSeconds
      if ($elapsed -gt 0 -and $elapsed -le [Math]::Max(60, [int]$Config.pollSeconds * 3)) {
        $cuttingDelta = if ($currentCuttingSeconds -ge [double]$previousCutting) {
          $currentCuttingSeconds - [double]$previousCutting
        } else {
          $currentCuttingSeconds
        }
        if ($cuttingDelta -ge 0 -and $cuttingDelta -le ($elapsed + 2)) {
          $workSignal = 'controller_cutting_timer'
          $workActive = $cuttingDelta -gt 0
          $executionState = if ($workActive) { 'running' } else { 'stopped' }
        }
      }
    }
  }

  if ($Snapshot.connected -and $workSignal -eq 'unavailable' -and $Snapshot.state -eq 'programming') {
    # Conservative fallback: this proves the machine's NC program is changing,
    # but it is not presented as an actual CycleStart signal in the UI.
    $workSignal = 'program_activity'
    $workActive = $true
  }

  $worked = 0
  $cuttingToday = 0
  $online = 0
  $previousDay = [string](Get-DynamicProperty $Previous 'workDay')
  if ($previousDay -eq $day) {
    $oldWorked = Get-DynamicProperty $Previous 'workedTodaySeconds'
    $oldCutting = Get-DynamicProperty $Previous 'cuttingTodaySeconds'
    $oldOnline = Get-DynamicProperty $Previous 'onlineTodaySeconds'
    if ($null -ne $oldWorked) { $worked = [int]$oldWorked }
    if ($null -ne $oldCutting) { $cuttingToday = [double]$oldCutting }
    if ($null -ne $oldOnline) { $online = [int]$oldOnline }

    $previousObservedRaw = Get-DynamicProperty $Previous 'observedAt'
    if ($previousObservedRaw) {
      $delta = [int][Math]::Floor(($observed - (Convert-IsoOffset $previousObservedRaw)).TotalSeconds)
      $maxDelta = [Math]::Max(60, [int]$Config.pollSeconds * 3)
      if ($delta -gt 0 -and $delta -le $maxDelta) {
        $runtimeOnline = [bool]$runtimeResult.transportAvailable
        if ([bool](Get-DynamicProperty $Previous 'connected') -and ($Snapshot.connected -or $runtimeOnline)) { $online += $delta }

        if ($null -ne $currentCuttingSeconds) {
          $previousCutting = Get-DynamicProperty $Previous 'currentCuttingSeconds'
          if ($null -ne $previousCutting) {
            $timerDelta = if ($currentCuttingSeconds -ge [double]$previousCutting) {
              $currentCuttingSeconds - [double]$previousCutting
            } else {
              # LYNUC resets #33565 when a new cycle begins.
              $currentCuttingSeconds
            }
            if ($timerDelta -ge 0 -and $timerDelta -le ($delta + 2)) { $cuttingToday += $timerDelta }
          }
          $worked = [int][Math]::Floor($cuttingToday)
        } elseif ([bool](Get-DynamicProperty $Previous 'workActive') -and $workActive) {
          $worked += $delta
        }
      }
    }
  }

  $cycleStarted = $null
  if ($workSignal -in @('controller_cycle', 'controller_cutting_timer') -and $workActive) {
    $wasRunning = [bool](Get-DynamicProperty $Previous 'workActive') -and
      ([string](Get-DynamicProperty $Previous 'workSignal') -eq $workSignal)
    $storedStart = Get-DynamicProperty $Previous 'currentCycleStartedAt'
    $cycleStarted = if ($wasRunning -and $storedStart) { (Convert-IsoOffset $storedStart).ToString('o') } else { $observed.ToString('o') }
  }

  $Snapshot.executionState = $executionState
  $Snapshot.workSignal = $workSignal
  $Snapshot.workDay = $day
  $Snapshot.workedTodaySeconds = $worked
  $Snapshot.cuttingTodaySeconds = [int][Math]::Floor($cuttingToday)
  $Snapshot.onlineTodaySeconds = $online
  $Snapshot.currentCycleStartedAt = $cycleStarted

  Set-DynamicProperty $State 'observedAt' $observed.ToString('o')
  Set-DynamicProperty $State 'connected' ([bool]$Snapshot.connected)
  Set-DynamicProperty $State 'workActive' $workActive
  Set-DynamicProperty $State 'workSignal' $workSignal
  Set-DynamicProperty $State 'workDay' $day
  Set-DynamicProperty $State 'workedTodaySeconds' $worked
  Set-DynamicProperty $State 'cuttingTodaySeconds' $cuttingToday
  Set-DynamicProperty $State 'onlineTodaySeconds' $online
  Set-DynamicProperty $State 'currentCycleStartedAt' $cycleStarted
  Set-DynamicProperty $State 'currentCycleSeconds' $currentCycleSeconds
  Set-DynamicProperty $State 'currentCuttingSeconds' $currentCuttingSeconds
  Set-DynamicProperty $State 'controllerBootCycleSeconds' $controllerBootCycleSeconds
  Set-DynamicProperty $State 'telemetrySource' ([string]$Snapshot.telemetrySource)
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
    totalCompletedParts = $null
    targetParts = $null
    currentCycleSeconds = $null
    currentCuttingSeconds = $null
    controllerBootCycleSeconds = $null
    cuttingTodaySeconds = 0
    telemetrySource = 'unavailable'
    runtimeObservedAt = $null
    runtimeLatencyMs = $null
    runtimeError = $null
    discoveryStatus = 'not_started'
    discoveryConfidence = 0
    discoveredServices = @()
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

if ($DiscoverRuntime) {
  $discoveries = @()
  foreach ($machine in $config.machines) {
    $runtime = Get-DynamicProperty $machine 'runtime'
    $port = if ($null -ne $runtime -and (Get-DynamicProperty $runtime 'port')) { [int]$runtime.port } else { 502 }
    $services = @(Get-LynucServiceInventory ([string]$machine.ip) $port)
    $result = Find-LynucRuntimeCandidate ([string]$machine.ip) $port
    $discoveries += [pscustomobject]@{
      id = [string]$machine.id
      ip = [string]$machine.ip
      requests = [int]$result.requests
      phasesTried = [int]$result.phasesTried
      candidateCount = [int]$result.candidateCount
      bestScore = $result.bestScore
      ambiguous = [bool]$result.ambiguous
      services = $services
      selectedProfile = if ($null -ne $result.candidate) { [string]$result.candidate.runtime.profile } else { $null }
      values = if ($null -ne $result.candidate) { $result.candidate.values } else { $null }
    }
  }
  $discoveries | ConvertTo-Json -Depth 12
  return
}

if ($DeepDiscoverRuntime) {
  $deepDiscoveries = @()
  foreach ($machine in $config.machines) {
    $runtime = Get-DynamicProperty $machine 'runtime'
    $port = if ($null -ne $runtime -and (Get-DynamicProperty $runtime 'port')) { [int]$runtime.port } else { 502 }
    Write-WatcherLog "$($machine.name) starting explicit deep read-only Modbus survey" 'WARN'
    $result = Find-DeepLynucRuntimeCandidate ([string]$machine.ip) $port
    $selected = $null
    if ($null -ne $result.candidate) {
      $selected = $result.candidate.runtime
      Set-DynamicProperty $machine 'runtime' $selected
      Write-WatcherLog "$($machine.name) deep survey found unique candidate $($selected.profile)" 'WARN'
    }
    $deepDiscoveries += [pscustomobject]@{
      id = [string]$machine.id; ip = [string]$machine.ip; requests = [int]$result.requests
      candidateCount = [int]$result.candidateCount; bestScore = $result.bestScore
      ambiguous = [bool]$result.ambiguous; selectedProfile = if ($selected) { $selected.profile } else { $null }
      values = if ($result.candidate) { $result.candidate.values } else { $null }
      surveys = $result.surveys
    }
  }
  Write-JsonAtomic $ConfigPath $config 16
  $deepDiscoveries | ConvertTo-Json -Depth 16
  return
}

if ($TestRuntime) {
  $diagnostics = @()
  foreach ($machine in $config.machines) {
    $runtime = Get-DynamicProperty $machine 'runtime'
    if ($null -eq $runtime) { $runtime = [pscustomobject]@{ port = 502; unitId = 1; verified = $false; fields = [pscustomobject]@{} } }
    $result = Get-LynucRuntimeTelemetry ([string]$machine.ip) $runtime
    $diagnostics += [pscustomobject]@{
      id = [string]$machine.id
      ip = [string]$machine.ip
      transportAvailable = [bool]$result.transportAvailable
      exact = [bool]$result.exact
      latencyMs = [int]$result.latencyMs
      values = $result.values
      error = $result.error
    }
  }
  $diagnostics | ConvertTo-Json -Depth 12
  return
}

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
