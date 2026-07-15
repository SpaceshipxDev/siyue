# Yingma CNC Network Reader 3.0

This is a read-only Windows edge service for `yingma.siyue.ai/machines/dev`.
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
4. Every field on `/machines/dev` says either **readable** and names its source,
   or **not exposed** and explains the missing interface.

The service can discover from the Windows PC without walking to a machine. It
cannot remotely enable a controller server that is currently disabled. That is
a controller configuration fact, not a software limitation that a network
scanner can bypass safely.

## Factory controller classes found in the 13 photos

| Controller class | Photos | What the open-only reader can do immediately |
| --- | --- | --- |
| LYNUC | IMG_7260, IMG_7261, IMG_7281 | Anonymous FTP program files and the existing read-only Modbus runtime mapping |
| FANUC Series 0i-MF Plus | IMG_7257, IMG_7258, IMG_7284 | Detect a reachable FOCAS endpoint; read full runtime only if an MTConnect endpoint is already present |
| Mitsubishi M80 | IMG_7254, IMG_7255, IMG_7256, IMG_7287, IMG_7288 | Read an existing MTConnect endpoint or read-only FTP file service; otherwise report the Mitsubishi interface gap |
| Mitsubishi E80 | IMG_7259 | Same open-interface path as M80 |

The photos also show SANZZN LV-800 machines and another builder panel marked
T-7C/VR-8. The controller family, not the machine-tool badge, decides the data
protocol.

## Exactly what each interface supplies

| Data | FTP | MTConnect | LYNUC Modbus mapping | FOCAS detected only |
| --- | ---: | ---: | ---: | ---: |
| IP and reachable services | yes | yes | yes | yes |
| Latest available program filename | yes | often | no | no |
| True currently executing program | no | yes, when the adapter publishes `Program` | no | no |
| NC source text | yes | no standard data item | no | no |
| Running / paused / stopped | no | yes, from `Execution` | yes, after verified mapping | no |
| Completed and target count | no | yes, when published | yes, after verified mapping | no |
| Cycle and cutting duration | CAM estimate only | yes, when published | yes, after verified mapping | no |
| Spindle and feed | parsed from program | yes, when published | not in the current mapping | no |

FTP's newest file is not guaranteed to be the executing file. The dashboard
labels the source so this distinction remains visible.

## Why FANUC and Mitsubishi are different

FANUC documents FOCAS2 as its Windows PC library for reading CNC program data,
axes, spindle, diagnostics, alarms, and related controller data over Ethernet.
FOCAS is not an open wire standard, so this collector fingerprints the endpoint
but does not reverse-engineer it. FANUC's own MTConnect Server uses FOCAS below
the surface and can expose program and part count through MTConnect.

Mitsubishi documents NC Explorer for viewing M80/E80 machining files from
Windows Explorer, and its MTConnect Data Collector supports M80/E80 adapters.
The native Mitsubishi adapter layer is not an open wire protocol. When that
adapter already exposes MTConnect, this collector reads it with ordinary HTTP
and XML without installing a proprietary SDK into the collector.

Official references:

- [FANUC FOCAS2 Library](https://www.fanucamerica.com/products/software/focas2-library)
- [FANUC 0i-MF Plus](https://www.fanuc.eu/eu-en/product/cnc/0i-mf-plus)
- [FANUC MTConnect Server](https://www.fanucamerica.com/es-mx/productos/software/mt-connect-server)
- [Mitsubishi NC Explorer for M80/E80](https://fa-faq.mitsubishielectric.com/fa/products/cnt/cnc/smerit/nc_explorer/index.html)
- [Mitsubishi MTConnect Data Collector](https://www.mitsubishielectric.com/fa/products/cnt/cnc/pmerit/iot/mtconnect_data_collector/index.html)
- [MTConnect standard](https://www.mtconnect.org/standard-download20181)

## Install from Windows PowerShell

Requirements are Windows 10/11 or Windows Server, LAN access to the CNC VLAN,
and outbound HTTPS access to `yingma.siyue.ai`.

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
`ListDirectoryDetails` and `DownloadFile`. NC text is capped at 128 KiB for the
dashboard and uploaded only when the program fingerprint changes. The full CNC
file is never modified.

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

Daily logs are retained for 14 days. During an internet outage, the latest
payload remains in `pending.json` and polling continues.

## Upgrade and remove

From an extracted newer release, run `update.ps1` as Administrator. It preserves
the token and machine configuration, updates both PowerShell files, runs the
read-only diagnostics, uploads one snapshot, and restarts the task.

Run `uninstall.ps1` as Administrator to remove the task and program. Add
`-RemoveData` only when configuration, state, and logs should also be deleted.
