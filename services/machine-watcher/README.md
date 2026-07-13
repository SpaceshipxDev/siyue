# Yingma Machine Watcher

Read-only Windows edge collector for the three Lynuc controls on
`192.168.10.140`–`192.168.10.142`.

It polls anonymous FTP every 15 seconds, identifies the latest main NC
program, reads only the first 512 KB of its header, and extracts:

- controller availability and FTP latency;
- current/latest main program and its last modification time;
- source part file and program number;
- CAM program timestamp;
- operation count, tool list, first programmed spindle/feed values;
- estimated total machine time and per-operation estimates when the CAM
  header provides them;
- total NC file count and recent program updates;
- online time since 00:00 Shanghai, reset every calendar day;
- confirmed work activity since 00:00 Shanghai, shown as `HH:MM:SS`.

Actual cycle state, completed-piece count, target-piece count, alarm state,
and current operation remain `null` until the Lynuc runtime interface is
mapped on each controller. Until then, the work counter advances only while
the NC program is observably changing and the dashboard labels it **program
activity**, not controller-confirmed cutting time. The separate online counter
must not be interpreted as machining time.

The official Lynuc PLC interface defines `F_CYCLESTART` as the signal that
stays active while an NC program is machining. Once the machine builder
confirms the holding-register mapping, add a read-only mapping to that
machine's `config.json` entry:

```json
"runSignal": {
  "port": 502,
  "unitId": 1,
  "address": 123,
  "bitMask": 1,
  "activeValue": 1
}
```

`address` above is intentionally an example, not a default. With a verified
mapping, the dashboard labels the counter **CNC CycleStart** and reports live
running/stopped state. The collector never sends FTP writes, renames, deletes,
SSH/VNC commands, or Modbus write functions.

## Install on Windows

Requirements: Windows 10/11 or Windows Server, LAN access to the three CNCs,
and outbound HTTPS access to `yingma.siyue.ai`.

1. Copy the release folder to the Windows machine.
2. Open **Windows PowerShell as Administrator**.
3. Run the generated `Install-YingmaWatcher.ps1` release helper, or run:

   ```powershell
   Set-ExecutionPolicy -Scope Process Bypass
   .\install.ps1 -Token '<production ingest token>'
   ```

The installer performs one visible diagnostic collection and upload, then
registers `Yingma Machine Watcher` as a SYSTEM scheduled task. It starts at
boot, runs with no logged-in user, restarts up to 999 times after failures,
and prevents duplicate instances.

Runtime data lives under:

```text
C:\ProgramData\Yingma\MachineWatcher\
```

Daily logs are retained for 14 days. The latest unsent snapshot is retained
as `pending.json` during an internet outage; machine polling continues.

## Diagnostics

```powershell
& 'C:\ProgramData\Yingma\MachineWatcher\YingmaMachineWatcher.ps1' `
  -ConfigPath 'C:\ProgramData\Yingma\MachineWatcher\config.json' -Once

Get-ScheduledTask -TaskName 'Yingma Machine Watcher'
Get-Content 'C:\ProgramData\Yingma\MachineWatcher\logs\watcher-*.log' -Tail 100
```

## Remove

Run `uninstall.ps1` as Administrator. Add `-RemoveData` to delete configuration,
state, and logs too.
