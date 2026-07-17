# Yingma CNC Network Reader 4.1.0

This is a read-only Windows edge service for `yingma.siyue.ai/machines`.
It discovers CNC network endpoints, identifies what can be read, collects the
available values, and uploads them over HTTPS. It has no PLC write, CNC command,
file upload, rename, or delete code.

## The simple mental model

Think of each CNC as a locked room with several windows:

1. Ethernet is the road to the room. A road does not mean a window is open.
2. Network discovery checks only six known windows: FTP, HTTP, HTTPS, Modbus
   TCP, the documented Mitsubishi MELDAS endpoint, MTConnect HTTP, and the
   common FANUC FOCAS endpoint.
3. If an open-standard window answers, the reader looks through it using GET or
   a read-only request.
4. Native FANUC FOCAS2 and Mitsubishi EZSocket results are normalized and the
   original read results are relayed for later server-side synthesis.
5. Every field on `/machines/dev` names its source or explains the missing
   machine-builder mapping.

The service can discover from the Windows PC without walking to a machine. It
cannot remotely enable a controller server that is currently disabled. That is
a controller configuration fact, not a software limitation that a network
scanner can bypass safely.

## Factory controller classes found in the 13 photos

| Controller class | Photos | Read-only driver |
| --- | --- | --- |
| LYNUC | IMG_7260, IMG_7261, IMG_7281 | Anonymous FTP program files and the existing read-only Modbus runtime mapping |
| FANUC Series 0i-MF Plus | IMG_7257, IMG_7258, IMG_7284 | Official 32-bit FOCAS2 library over TCP 8193 |
| Mitsubishi M80 | IMG_7254, IMG_7255, IMG_7256, IMG_7287, IMG_7288 | Official 32-bit EZSocket automation runtime over TCP 683 |
| Mitsubishi E80 | IMG_7259 | Same EZSocket path as M80 |

The photos also show SANZZN LV-800 machines and another builder panel marked
T-7C/VR-8. The controller family, not the machine-tool badge, decides the data
protocol.

## Exactly what each interface supplies

| Data | FTP | MTConnect | LYNUC Modbus mapping | FANUC FOCAS | Mitsubishi EZSocket |
| --- | ---: | ---: | ---: | ---: |
| IP and reachable services | yes | yes | yes | yes | yes |
| Latest available program filename | yes | often | no | yes | yes |
| True currently executing program | no | when published | no | yes | yes |
| NC source text | yes | no standard data item | no | yes | yes |
| Running / paused / stopped | no | yes | after verified mapping | yes | yes |
| Completed and target count | no | when published | after verified mapping | standard #3901/#3902 | standard WRK COUNT #8002/#8003 |
| Cycle and cutting duration | CAM estimate | when published | after verified mapping | yes | yes |
| Spindle and feed | parsed from program | when published | mapping-dependent | yes | yes |

FTP's newest file is not guaranteed to be the executing file. The dashboard
labels the source so this distinction remains visible.

## Why FANUC and Mitsubishi are different

FANUC documents FOCAS2 as its Windows PC library for reading CNC program data,
axes, spindle, diagnostics, alarms, and related controller data over Ethernet.
FOCAS is not an open wire standard. The collector calls only the official
CNC-to-PC read functions for status, program identity/source, timers, standard
part macros, feed, and spindle. It imports no write or cycle-control functions.

Mitsubishi documents NC Explorer for viewing M80/E80 machining files from
Windows Explorer, and its MTConnect Data Collector supports M80/E80 adapters.
The Mitsubishi driver calls documented EZSocket automation methods for status,
current program, program file reads, timers, feed, spindle, and the standard
WRK COUNT/WRK COUNT LIMIT parameters #8002/#8003. Values are relayed only when
the controller returns them; they are never guessed.

Official references:

- [FANUC FOCAS2 Library](https://www.fanucamerica.com/products/software/focas2-library)
- [FANUC 0i-MF Plus](https://www.fanuc.eu/eu-en/product/cnc/0i-mf-plus)
- [FANUC MTConnect Server](https://www.fanucamerica.com/es-mx/productos/software/mt-connect-server)
- [Mitsubishi NC Explorer for M80/E80](https://fa-faq.mitsubishielectric.com/fa/products/cnt/cnc/smerit/nc_explorer/index.html)
- [Mitsubishi MTConnect Data Collector](https://www.mitsubishielectric.com/fa/products/cnt/cnc/pmerit/iot/mtconnect_data_collector/index.html)
- [MTConnect standard](https://www.mtconnect.org/standard-download20181)

## Install from Windows PowerShell

Requirements are x64 Windows 10/11 or Windows Server, LAN access to the CNC
VLAN, outbound HTTPS access to `yingma.siyue.ai`, the official 32-bit FANUC
FOCAS2 runtime (`Fwlib32.dll`), and the official 32-bit Mitsubishi
EZSocket/FCSB1224W100 runtime. The service runs under 32-bit Windows PowerShell
(`SysWOW64`) because Mitsubishi's in-process COM component does not support
native 64-bit operation.

1. Extract the release zip on the Windows PC.
2. Open **Windows PowerShell as Administrator** inside the extracted folder.
3. Enter the ingest token without putting it in PowerShell history:

   ```powershell
   Set-ExecutionPolicy -Scope Process Bypass
   $secureToken = Read-Host 'Paste MACHINE_INGEST_TOKEN' -AsSecureString
   $token = [Net.NetworkCredential]::new('', $secureToken).Password
   .\install.ps1 -Token $token
   Remove-Variable token, secureToken
   ```

The current package is available at
`https://yingma.siyue.ai/machines/reader`.

The private factory package also contains `INSTALL-FACTORY.cmd` and a
`factory.token` file. Right-click `INSTALL-FACTORY.cmd`, choose **Run as
administrator**, approve the Windows prompt, and leave the window open until
it says `INSTALL COMPLETE`. No token typing or PowerShell copy/paste is needed.

The installer is preconfigured for `192.168.10.81` through `.95`. It identifies
port 8193 as FANUC FOCAS and port 683 as Mitsubishi EZSocket without asking the
operator which controller is attached. It does not duplicate the existing
LYNUC deployment.

The installer copies the reader to
`C:\ProgramData\Yingma\MachineWatcher`, performs visible diagnostics and one
upload, then starts a SYSTEM scheduled task. The task starts at boot and does
not require a logged-in Windows user.

## Discover every reachable CNC endpoint now

This command scans the Windows PC's connected IPv4 networks. Networks broader
than `/24` are intentionally reduced to the local `/24`, preventing an
accidental factory-wide enterprise scan.

```powershell
$root = 'C:\ProgramData\Yingma\MachineWatcher'
& "$root\YingmaMachineWatcher.ps1" -ConfigPath "$root\config.json" -DiscoverNetwork |
  ConvertFrom-Json |
  Where-Object isCnc |
  Format-Table ip, manufacturer, model, controller, driver, discoveryConfidence -AutoSize
```

To save high-confidence discovered CNCs into `config.json`:

```powershell
$root = 'C:\ProgramData\Yingma\MachineWatcher'
& "$root\YingmaMachineWatcher.ps1" -ConfigPath "$root\config.json" -AdoptDiscovery
```

The normal service also performs this safe discovery at startup when
`discovery.enabled` is `true`.

## Restrict discovery to CNC subnets

Open `C:\ProgramData\Yingma\MachineWatcher\config.json` as Administrator and
set explicit CIDRs after the first inventory. For example, if the Windows PC
shows an address in `192.168.10.x`, use:

```json
"discovery": {
  "enabled": true,
  "subnets": ["192.168.10.0/24"],
  "ports": [21, 80, 443, 502, 683, 5000, 8193],
  "maxHosts": 1024
}
```

The CIDR parser accepts `/16` through `/30` but refuses more than `maxHosts`.
The port list is an allowlist. Discovery sends TCP connection handshakes only;
it does not send controller protocol commands.

## Configure a discovered MTConnect CNC

The automatic probe adds this record when `/probe` returns a valid
`MTConnectDevices` document:

```json
{
  "id": "cnc-192-168-10-50",
  "name": "FANUC machining center",
  "ip": "192.168.10.50",
  "driver": "mtconnect",
  "manufacturer": "FANUC",
  "model": "0i-MF Plus",
  "controller": "FANUC 0i-MF Plus",
  "mtConnectPort": 5000
}
```

The collector performs only `GET /probe` and `GET /current`. It reads standard
`Execution`, `Program`, `PartCount`, target count, cycle/cutting timers,
spindle speed, and path feed data items when the machine publishes them.

## Configure read-only FTP credentials

Anonymous FTP needs no `ftp` section. If a controller already has a dedicated
read-only account, add its credentials to that machine record:

```json
{
  "driver": "ftp",
  "ftp": {
    "username": "yingma_reader",
    "password": "the password assigned to the read-only CNC account"
  }
}
```

The account should have list and download permission only. The code uses only
`ListDirectoryDetails` and `DownloadFile`. NC text is capped at 2 MiB and
uploaded only when the program fingerprint changes. A truncation flag is
explicit if a controller file exceeds that bound. The CNC file is never
modified.

## LYNUC runtime values

The existing LYNUC driver retains its bounded read-only Modbus autodiscovery.
After a mapping is verified, it reads controller macro values for current cycle
time, cutting time, boot-total cycle time, completed parts, total parts, and
target parts. Normal load is six read requests in one TCP session every 15
seconds. The driver implements Modbus functions 03 and 04 only.

Run the LYNUC-only diagnostics with:

```powershell
$root = 'C:\ProgramData\Yingma\MachineWatcher'
& "$root\YingmaMachineWatcher.ps1" -ConfigPath "$root\config.json" -TestRuntime
& "$root\YingmaMachineWatcher.ps1" -ConfigPath "$root\config.json" -DiscoverRuntime
```

The explicit deep LYNUC survey is read-only but makes many requests and should
be run once, not in the normal loop:

```powershell
$root = 'C:\ProgramData\Yingma\MachineWatcher'
& "$root\YingmaMachineWatcher.ps1" -ConfigPath "$root\config.json" -DeepDiscoverRuntime
```

## Verify collection and view results

```powershell
$root = 'C:\ProgramData\Yingma\MachineWatcher'
& "$root\YingmaMachineWatcher.ps1" -ConfigPath "$root\config.json" -Once
Get-ScheduledTask -TaskName 'Yingma Machine Watcher'
Get-Content "$root\logs\watcher-*.log" -Tail 100
```

Open:

- `https://yingma.siyue.ai/machines/dev` for discovery evidence, every field,
  the capability matrix, and NC source;
- `https://yingma.siyue.ai/machines` for the production status view.

Daily logs are retained for 14 days. Every telemetry cycle is first written
atomically to the append-only `spool` directory. During an internet outage or
server restart, polling continues and no queued cycle is overwritten. After
connectivity returns, batches replay oldest-first and are deleted only after a
positive server acknowledgement. The server makes each batch idempotent by
collector ID plus observation time.

## Upgrade and remove

From an extracted newer release, run `update.ps1` as Administrator. It preserves
the token and machine configuration, updates all PowerShell modules, runs the
read-only diagnostics, uploads one snapshot, and restarts the task.

Run `uninstall.ps1` as Administrator to remove the task and program. Add
`-RemoveData` only when configuration, state, and logs should also be deleted.
