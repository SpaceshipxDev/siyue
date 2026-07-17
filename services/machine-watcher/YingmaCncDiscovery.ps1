#requires -Version 5.1

# Read-only, open-protocol CNC discovery and MTConnect telemetry helpers.
# This module only performs ICMP, TCP connect, HTTP GET, and controller file GET
# operations. It never sends a machine command, PLC write, or file upload.

$script:CncPortNames = @{
  21 = 'ftp'
  80 = 'http'
  443 = 'https'
  502 = 'modbus-tcp'
  683 = 'mitsubishi-meldas'
  5000 = 'mtconnect-http'
  8193 = 'fanuc-focas'
}

function Get-CncConfigValue {
  param($Object, [string]$Name, $Fallback)
  if ($null -eq $Object) { return $Fallback }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property -or $null -eq $property.Value) { return $Fallback }
  return $property.Value
}

function Convert-CncIpToUInt32 {
  param([string]$Address)
  $bytes = [Net.IPAddress]::Parse($Address).GetAddressBytes()
  if ([BitConverter]::IsLittleEndian) { [Array]::Reverse($bytes) }
  return [BitConverter]::ToUInt32($bytes, 0)
}

function Convert-CncUInt32ToIp {
  param([uint32]$Address)
  $bytes = [BitConverter]::GetBytes($Address)
  if ([BitConverter]::IsLittleEndian) { [Array]::Reverse($bytes) }
  return (New-Object Net.IPAddress (,$bytes)).ToString()
}

function Expand-CncCidr {
  param([string]$Cidr, [int]$MaximumHosts = 1024)
  if ($Cidr -notmatch '^(?<ip>\d{1,3}(?:\.\d{1,3}){3})/(?<prefix>\d{1,2})$') {
    throw "Invalid IPv4 CIDR: $Cidr"
  }
  $prefix = [int]$Matches.prefix
  if ($prefix -lt 16 -or $prefix -gt 30) {
    throw "Discovery CIDR must be between /16 and /30: $Cidr"
  }
  $ip = Convert-CncIpToUInt32 $Matches.ip
  $hostBits = 32 - $prefix
  $size = [uint64][Math]::Pow(2, $hostBits)
  if (($size - 2) -gt $MaximumHosts) {
    throw "Discovery CIDR $Cidr contains more than $MaximumHosts usable hosts"
  }
  $mask = [uint32]([uint64]4294967295 - ([uint64][Math]::Pow(2, $hostBits) - 1))
  $network = [uint32]($ip -band $mask)
  $addresses = New-Object Collections.Generic.List[string]
  for ($offset = [uint64]1; $offset -lt ($size - 1); $offset++) {
    $addresses.Add((Convert-CncUInt32ToIp ([uint32]([uint64]$network + $offset))))
  }
  return @($addresses)
}

function Get-CncLocalCidrs {
  $cidrs = New-Object Collections.Generic.List[string]
  try {
    $addresses = @(Get-NetIPAddress -AddressFamily IPv4 -Type Unicast -ErrorAction Stop |
      Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' })
    foreach ($address in $addresses) {
      $prefix = [Math]::Max(24, [int]$address.PrefixLength)
      $ipValue = Convert-CncIpToUInt32 ([string]$address.IPAddress)
      $hostBits = 32 - $prefix
      $mask = [uint32]([uint64]4294967295 - ([uint64][Math]::Pow(2, $hostBits) - 1))
      $network = Convert-CncUInt32ToIp ([uint32]($ipValue -band $mask))
      $cidr = "$network/$prefix"
      if (-not $cidrs.Contains($cidr)) { $cidrs.Add($cidr) }
    }
  } catch {
    throw "Cannot read local IPv4 interfaces: $($_.Exception.Message)"
  }
  return @($cidrs)
}

function Invoke-CncTcpBatch {
  param([string[]]$Addresses, [int[]]$Ports, [int]$TimeoutMs = 450)
  $attempts = New-Object Collections.Generic.List[object]
  foreach ($address in $Addresses) {
    foreach ($port in $Ports) {
      $client = New-Object Net.Sockets.TcpClient
      $watch = [Diagnostics.Stopwatch]::StartNew()
      try {
        $async = $client.BeginConnect($address, $port, $null, $null)
        $attempts.Add([pscustomobject]@{ Address = $address; Port = $port; Client = $client; Async = $async; Watch = $watch })
      } catch {
        $watch.Stop()
        $client.Dispose()
      }
    }
  }
  Start-Sleep -Milliseconds $TimeoutMs
  $open = New-Object Collections.Generic.List[object]
  foreach ($attempt in $attempts) {
    try {
      if ($attempt.Async.IsCompleted -and $attempt.Client.Connected) {
        $attempt.Client.EndConnect($attempt.Async)
        $attempt.Watch.Stop()
        $name = if ($script:CncPortNames.ContainsKey([int]$attempt.Port)) {
          $script:CncPortNames[[int]$attempt.Port]
        } else {
          'tcp'
        }
        $open.Add([pscustomobject]@{
          ip = [string]$attempt.Address
          port = [int]$attempt.Port
          name = $name
          latencyMs = [int][Math]::Max(0, $attempt.Watch.ElapsedMilliseconds)
        })
      }
    } catch {
    } finally {
      $attempt.Watch.Stop()
      $attempt.Client.Dispose()
    }
  }
  return $open.ToArray()
}

function Invoke-CncHttpGet {
  param([string]$Uri, [int]$TimeoutSeconds = 4)
  try {
    $response = Invoke-WebRequest -Uri $Uri -Method Get -UseBasicParsing -TimeoutSec $TimeoutSeconds -MaximumRedirection 2
    return [pscustomobject]@{ ok = $true; status = [int]$response.StatusCode; content = [string]$response.Content; error = $null }
  } catch {
    return [pscustomobject]@{ ok = $false; status = $null; content = $null; error = $_.Exception.Message }
  }
}

function Get-CncMtConnectProbe {
  param([string]$HostName, [int[]]$Ports = @(5000, 80))
  foreach ($port in $Ports) {
    $uri = "http://${HostName}:$port/probe"
    $result = Invoke-CncHttpGet $uri
    if (-not $result.ok -or $result.content -notmatch '(?i)MTConnectDevices') { continue }
    try {
      [xml]$xml = $result.content
      $device = $xml.SelectSingleNode("//*[local-name()='Device']")
      $description = $xml.SelectSingleNode("//*[local-name()='Description']")
      $manufacturer = if ($description -and $description.manufacturer) { [string]$description.manufacturer } else { $null }
      $model = if ($description -and $description.model) { [string]$description.model } else { $null }
      $deviceName = if ($device -and $device.name) { [string]$device.name } else { $null }
      return [pscustomobject]@{
        available = $true
        port = $port
        uri = $uri
        manufacturer = $manufacturer
        model = $model
        deviceName = $deviceName
      }
    } catch {
      return [pscustomobject]@{ available = $true; port = $port; uri = $uri; manufacturer = $null; model = $null; deviceName = $null }
    }
  }
  return $null
}

function Get-CncXmlValue {
  param([xml]$Xml, [string[]]$LocalNames)
  foreach ($localName in $LocalNames) {
    $node = $Xml.SelectSingleNode("//*[local-name()='$localName' and not(@unavailable='true')]")
    if ($node -and -not [string]::IsNullOrWhiteSpace([string]$node.InnerText)) { return [string]$node.InnerText }
  }
  return $null
}

function Convert-CncSeconds {
  param($Value)
  if ($null -eq $Value -or [string]::IsNullOrWhiteSpace([string]$Value)) { return $null }
  $number = 0.0
  if ([double]::TryParse([string]$Value, [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$number)) {
    return [Math]::Max(0.0, $number)
  }
  try { return [Math]::Max(0.0, [Xml.XmlConvert]::ToTimeSpan([string]$Value).TotalSeconds) } catch { return $null }
}

function Convert-CncNullableNumber {
  param($Value)
  if ($null -eq $Value -or [string]::IsNullOrWhiteSpace([string]$Value)) { return $null }
  $number = 0.0
  if ([double]::TryParse([string]$Value, [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$number)) {
    return $number
  }
  return $null
}

function Get-CncMtConnectSnapshot {
  param($Machine, $Config, $Previous)
  $observed = [DateTimeOffset]::UtcNow
  $started = [Diagnostics.Stopwatch]::StartNew()
  $port = [int](Get-CncConfigValue $Machine 'mtConnectPort' 5000)
  $uri = "http://$([string]$Machine.ip):$port/current"
  $response = Invoke-CncHttpGet $uri
  $started.Stop()
  if (-not $response.ok -or $response.content -notmatch '(?i)MTConnectStreams') {
    $snapshot = New-SnapshotBase $Machine $observed.ToString('o') $false 'offline' $null $response.error
    $snapshot.driver = 'mtconnect'
    $snapshot.manufacturer = [string](Get-CncConfigValue $Machine 'manufacturer' '')
    $snapshot.model = [string](Get-CncConfigValue $Machine 'model' '')
    $snapshot.capabilities = Get-CncCapabilities $Machine $false $false
    return [pscustomobject]@{ snapshot = $snapshot; state = $Previous }
  }
  try { [xml]$xml = $response.content } catch {
    $snapshot = New-SnapshotBase $Machine $observed.ToString('o') $true 'error' $started.ElapsedMilliseconds 'MTConnect returned invalid XML'
    $snapshot.driver = 'mtconnect'
    return [pscustomobject]@{ snapshot = $snapshot; state = $Previous }
  }

  $executionRaw = Get-CncXmlValue $xml @('Execution')
  $execution = switch -Regex ([string]$executionRaw) {
    '^(ACTIVE|READY|RUNNING)$' { 'running'; break }
    '^(INTERRUPTED|FEED_HOLD|PAUSED)$' { 'paused'; break }
    '^(STOPPED|PROGRAM_STOPPED|OPTIONAL_STOP)$' { 'stopped'; break }
    default { 'unknown' }
  }
  $program = Get-CncXmlValue $xml @('Program', 'ProgramComment', 'PartId')
  $partCountValue = Convert-CncNullableNumber (Get-CncXmlValue $xml @('PartCount', 'GoodPartCount', 'PartCompleted'))
  $targetValue = Convert-CncNullableNumber (Get-CncXmlValue $xml @('PartCountTarget', 'PartTarget'))
  $cycleSeconds = Convert-CncSeconds (Get-CncXmlValue $xml @('CycleTime', 'ProcessTimer', 'PathPositionTime'))
  $cuttingSeconds = Convert-CncSeconds (Get-CncXmlValue $xml @('CuttingTime'))
  $spindle = Convert-CncNullableNumber (Get-CncXmlValue $xml @('SpindleSpeed', 'RotaryVelocity'))
  $feed = Convert-CncNullableNumber (Get-CncXmlValue $xml @('PathFeedrate', 'PathFeedrateOverride'))
  $state = if ($execution -eq 'running') { 'ready' } elseif ($execution -eq 'stopped') { 'idle' } else { 'unknown' }
  $snapshot = New-SnapshotBase $Machine $observed.ToString('o') $true $state $started.ElapsedMilliseconds $null
  $snapshot.driver = 'mtconnect'
  $snapshot.manufacturer = [string](Get-CncConfigValue $Machine 'manufacturer' '')
  $snapshot.model = [string](Get-CncConfigValue $Machine 'model' '')
  $snapshot.controller = [string](Get-CncConfigValue $Machine 'controller' 'MTConnect CNC')
  $snapshot.currentProgram = $program
  $snapshot.programCount = if ($program) { 1 } else { 0 }
  $snapshot.mainProgramCount = $snapshot.programCount
  $snapshot.completedParts = if ($null -ne $partCountValue) { [int64][Math]::Round($partCountValue) } else { $null }
  $snapshot.totalCompletedParts = $snapshot.completedParts
  $snapshot.targetParts = if ($null -ne $targetValue) { [int64][Math]::Round($targetValue) } else { $null }
  $snapshot.currentCycleSeconds = $cycleSeconds
  $snapshot.currentCuttingSeconds = $cuttingSeconds
  $snapshot.spindleRpm = $spindle
  $snapshot.feedMmMin = $feed
  $snapshot.executionState = $execution
  $snapshot.workSignal = if ($execution -eq 'unknown') { 'unavailable' } else { 'mtconnect_execution' }
  $snapshot.telemetrySource = 'mtconnect'
  $snapshot.runtimeObservedAt = $observed.ToString('o')
  $snapshot.runtimeLatencyMs = [int]$started.ElapsedMilliseconds
  $snapshot.discoveryStatus = 'mtconnect_readable'
  $snapshot.discoveryConfidence = 100
  $snapshot.discoveredServices = @([pscustomobject]@{ port = $port; name = 'mtconnect-http'; latencyMs = [int]$started.ElapsedMilliseconds })
  $snapshot.capabilities = Get-CncCapabilities $Machine $true $false
  $rawText = [string]$response.content
  $snapshot.rawTelemetry = [pscustomobject]@{
    adapter = 'mtconnect'
    endpoint = $uri
    currentXml = $rawText.Substring(0, [Math]::Min($rawText.Length, 524288))
    currentXmlTruncated = $rawText.Length -gt 524288
  }
  $nextState = if ($null -ne $Previous) { $Previous } else { [pscustomobject]@{} }
  Set-DynamicProperty $nextState 'currentProgram' $program
  Set-DynamicProperty $nextState 'observedAt' $observed.ToString('o')
  return [pscustomobject]@{ snapshot = $snapshot; state = $nextState }
}

function Get-CncCapabilities {
  param($Machine, [bool]$MtConnectReadable, [bool]$FtpReadable)
  $services = @((Get-CncConfigValue $Machine 'discoveredServices' @()))
  $hasFocas = @($services | Where-Object { [int]$_.port -eq 8193 }).Count -gt 0
  return [pscustomobject]@{
    identity = [pscustomobject]@{ readable = $true; source = 'network-discovery'; note = 'IP and listening services' }
    execution = [pscustomobject]@{ readable = $MtConnectReadable; source = if ($MtConnectReadable) { 'mtconnect' } elseif ($hasFocas) { 'focas-interface-detected' } else { 'none' }; note = if ($MtConnectReadable) { 'Read with HTTP GET /current' } elseif ($hasFocas) { 'FANUC FOCAS is present, but the open-protocol collector does not decode FOCAS' } else { 'No open runtime endpoint detected' } }
    programName = [pscustomobject]@{ readable = ($MtConnectReadable -or $FtpReadable); source = if ($MtConnectReadable) { 'mtconnect' } elseif ($FtpReadable) { 'ftp' } else { 'none' }; note = 'Current name needs MTConnect; FTP alone identifies the newest available file' }
    programSource = [pscustomobject]@{ readable = $FtpReadable; source = if ($FtpReadable) { 'ftp' } else { 'none' }; note = if ($FtpReadable) { 'Read-only file download' } else { 'MTConnect does not standardize NC source transfer' } }
    partCount = [pscustomobject]@{ readable = $MtConnectReadable; source = if ($MtConnectReadable) { 'mtconnect' } else { 'none' }; note = 'Requires a PartCount data item or controller mapping' }
    cycleDuration = [pscustomobject]@{ readable = $MtConnectReadable; source = if ($MtConnectReadable) { 'mtconnect' } else { 'none' }; note = 'Requires a timer data item or controller mapping' }
  }
}

function Get-CncFingerprint {
  param([string]$Address, [object[]]$Services)
  $mtPorts = @($Services | Where-Object { $_.port -in @(80, 5000) } | ForEach-Object { [int]$_.port })
  $probe = if ($mtPorts.Count -gt 0) { Get-CncMtConnectProbe $Address $mtPorts } else { $null }
  $ports = @($Services | ForEach-Object { [int]$_.port })
  $manufacturer = $null
  $controller = $null
  $driver = 'inventory'
  $confidence = 20
  $notes = New-Object Collections.Generic.List[string]
  if ($probe) {
    $driver = 'mtconnect'
    $manufacturer = $probe.manufacturer
    $controller = if ($probe.model) { [string]$probe.model } else { 'MTConnect CNC' }
    $confidence = 100
    $notes.Add('MTConnect /probe returned a valid MTConnectDevices document')
  } elseif ($ports -contains 8193) {
    $driver = 'focas'
    $manufacturer = 'FANUC'
    $controller = 'FANUC CNC (FOCAS endpoint detected)'
    $confidence = 85
    $notes.Add('TCP 8193 is reachable; this is a fingerprint, not a decoded FOCAS session')
  } elseif ($ports -contains 683) {
    $driver = 'ezsocket'
    $manufacturer = 'Mitsubishi Electric'
    $controller = 'MELDAS M80/E80-family CNC'
    $confidence = 85
    $notes.Add('TCP 683 is reachable; Mitsubishi documents this CNC communication endpoint for the M800/M80/E80 family')
  } elseif (($ports -contains 21) -and ($ports -contains 502)) {
    $controller = 'CNC with FTP and Modbus TCP'
    $driver = 'lynuc'
    $confidence = 70
    $notes.Add('FTP and Modbus TCP are both reachable')
  } elseif ($ports -contains 21) {
    $controller = 'FTP-capable industrial device'
    $driver = 'ftp'
    $confidence = 45
    $notes.Add('FTP is reachable; configure credentials before file reads')
  }
  return [pscustomobject]@{
    manufacturer = $manufacturer
    model = if ($probe) { $probe.model } else { $null }
    controller = $controller
    driver = $driver
    confidence = $confidence
    isCnc = ($confidence -ge 70)
    mtConnectPort = if ($probe) { [int]$probe.port } else { $null }
    notes = @($notes)
  }
}

function Invoke-CncNetworkDiscovery {
  param($DiscoveryConfig)
  $maximumHosts = [int](Get-CncConfigValue $DiscoveryConfig 'maxHosts' 1024)
  $cidrs = @((Get-CncConfigValue $DiscoveryConfig 'subnets' @()))
  $configuredAddresses = @((Get-CncConfigValue $DiscoveryConfig 'addresses' @()))
  if ($cidrs.Count -eq 0 -and $configuredAddresses.Count -eq 0) { $cidrs = @(Get-CncLocalCidrs) }
  $ports = @((Get-CncConfigValue $DiscoveryConfig 'ports' @(21, 80, 443, 502, 683, 5000, 8193)) | ForEach-Object { [int]$_ } | Sort-Object -Unique)
  $addresses = New-Object Collections.Generic.List[string]
  foreach ($configuredAddress in $configuredAddresses) {
    $parsedAddress = $null
    if (-not [Net.IPAddress]::TryParse([string]$configuredAddress, [ref]$parsedAddress) -or
        $parsedAddress.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) {
      throw "Invalid discovery IPv4 address: $configuredAddress"
    }
    if (-not $addresses.Contains([string]$configuredAddress)) { $addresses.Add([string]$configuredAddress) }
  }
  foreach ($cidr in $cidrs) {
    foreach ($address in (Expand-CncCidr ([string]$cidr) $maximumHosts)) {
      if (-not $addresses.Contains($address)) { $addresses.Add($address) }
    }
  }
  if ($addresses.Count -gt $maximumHosts) { throw "Discovery expands to $($addresses.Count) hosts; maxHosts is $maximumHosts" }
  $services = New-Object Collections.Generic.List[object]
  $batchSize = 32
  for ($offset = 0; $offset -lt $addresses.Count; $offset += $batchSize) {
    $last = [Math]::Min($addresses.Count - 1, $offset + $batchSize - 1)
    foreach ($service in (Invoke-CncTcpBatch @($addresses[$offset..$last]) $ports)) { $services.Add($service) }
  }
  $hosts = New-Object Collections.Generic.List[object]
  foreach ($group in ($services | Group-Object ip)) {
    $hostServices = @($group.Group | Select-Object port, name, latencyMs | Sort-Object port)
    $fingerprint = Get-CncFingerprint $group.Name $hostServices
    $safeId = ('cnc-' + $group.Name.Replace('.', '-')).ToLowerInvariant()
    $hosts.Add([pscustomobject]@{
      id = $safeId
      name = if ($fingerprint.controller) { [string]$fingerprint.controller } else { "Network device $($group.Name)" }
      ip = [string]$group.Name
      driver = [string]$fingerprint.driver
      manufacturer = $fingerprint.manufacturer
      model = $fingerprint.model
      controller = $fingerprint.controller
      discoveryConfidence = [int]$fingerprint.confidence
      isCnc = [bool]$fingerprint.isCnc
      mtConnectPort = $fingerprint.mtConnectPort
      discoveredServices = $hostServices
      discoveryNotes = @($fingerprint.notes)
    })
  }
  return @($hosts | Sort-Object ip)
}

function Update-CncStandardDailyTelemetry {
  param($Machine, $Config, $Previous, $Snapshot, $State)
  $observed = Convert-IsoOffset $Snapshot.observedAt
  $day = Get-WorkDay $observed ([string]$Config.workTimeZoneId)
  if ($null -eq $State) { $State = [pscustomobject]@{} }
  $worked = 0
  $online = 0
  if ([string](Get-DynamicProperty $Previous 'workDay') -eq $day) {
    $worked = [int](Get-CncConfigValue $Previous 'workedTodaySeconds' 0)
    $online = [int](Get-CncConfigValue $Previous 'onlineTodaySeconds' 0)
    $previousObserved = Get-DynamicProperty $Previous 'observedAt'
    if ($previousObserved) {
      $delta = [int][Math]::Floor(($observed - (Convert-IsoOffset $previousObserved)).TotalSeconds)
      $maxDelta = [Math]::Max(60, [int]$Config.pollSeconds * 3)
      if ($delta -gt 0 -and $delta -le $maxDelta) {
        if ([bool](Get-DynamicProperty $Previous 'connected') -and $Snapshot.connected) { $online += $delta }
        if ([string](Get-DynamicProperty $Previous 'executionState') -eq 'running' -and $Snapshot.executionState -eq 'running') { $worked += $delta }
      }
    }
  }
  $cycleStart = $null
  if ($Snapshot.executionState -eq 'running') {
    $storedStart = Get-DynamicProperty $Previous 'currentCycleStartedAt'
    $cycleStart = if ($storedStart -and [string](Get-DynamicProperty $Previous 'executionState') -eq 'running') { [string]$storedStart } else { $observed.ToString('o') }
  }
  $Snapshot.workDay = $day
  $Snapshot.workedTodaySeconds = $worked
  $Snapshot.cuttingTodaySeconds = $worked
  $Snapshot.onlineTodaySeconds = $online
  $Snapshot.currentCycleStartedAt = $cycleStart
  foreach ($pair in @{
    observedAt = $observed.ToString('o'); connected = [bool]$Snapshot.connected; executionState = [string]$Snapshot.executionState
    workSignal = [string]$Snapshot.workSignal; workDay = $day; workedTodaySeconds = $worked; cuttingTodaySeconds = $worked
    onlineTodaySeconds = $online; currentCycleStartedAt = $cycleStart; currentProgram = $Snapshot.currentProgram
  }.GetEnumerator()) { Set-DynamicProperty $State $pair.Key $pair.Value }
  $capturedFor = [string](Get-DynamicProperty $Previous 'programSourceCapturedFor')
  if ($Snapshot.programSourceSha256) {
    Set-DynamicProperty $State 'programSourceCapturedFor' ([string]$Snapshot.currentProgram)
    Set-DynamicProperty $State 'programSourceSha256' ([string]$Snapshot.programSourceSha256)
  } elseif ($capturedFor -eq [string]$Snapshot.currentProgram) {
    Set-DynamicProperty $State 'programSourceCapturedFor' $capturedFor
    Set-DynamicProperty $State 'programSourceSha256' ([string](Get-DynamicProperty $Previous 'programSourceSha256'))
  } else {
    Set-DynamicProperty $State 'programSourceCapturedFor' $null
    Set-DynamicProperty $State 'programSourceSha256' $null
  }
  return $State
}
