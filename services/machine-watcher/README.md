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
- exact controller cycle/cutting timers and part counts when a verified runtime
  mapping is configured;
- cutting time since 00:00 Shanghai, calculated from the controller's own
  `#33565` timer rather than wall-clock inference.
- controller-confirmed "cutting now" state whenever `#33565` advances between
  consecutive polls, kept distinct from FTP program activity.

The official LYNUC parameter manual defines these read-only macro variables:

- `#33564`: current cycle time, milliseconds;
- `#33565`: cutting time, milliseconds;
- `#33868`: accumulated cycle time since controller boot, milliseconds;
- `#33869`: current part count;
- `#33870`: total part count;
- `#33871`: target part count.

## Automatic discovery and load budget

With `verified: false` (the installer default), watcher 2.2 performs bounded
autodiscovery itself:

1. Once at startup, then at most once every six hours if unresolved, it checks
   only the allowlisted services FTP, SSH, HTTP(S), Modbus TCP, and VNC.
2. If Modbus TCP is open, it starts with unit 1/function 03 and tries eight
   documented-macro profiles covering direct/zero-based addressing and the
   four common word/byte orders. Only if that family yields no candidate does
   it fall back to function 04 and common gateway unit IDs 255 and 0. It stops
   at the first unambiguous family. The conservative hard ceiling is 288
   read-only register requests per discovery run per machine; the normal case
   is 48, and rejected profiles usually stop on their first request.
3. A plausible profile is not trusted immediately. It must preserve timer and
   count relationships across at least eight samples and show at least two
   physically possible timer movements. An idle machine is accepted only after
   20 stable valid samples.
4. Failed or ambiguous profiles are rejected and retried later. Values are not
   uploaded as controller telemetry until the profile is automatically locked.

After a profile locks, normal load is six read-only requests in one TCP session
every 15 seconds. There is no full port sweep, no full register sweep, no
credential guessing, and no Modbus/FTP/PLC write.

The watcher supports Modbus TCP functions 03 and 04 only. It never issues a
write function. The public LYNUC manuals do not specify the Modbus addresses,
so mappings must be verified against the controller or supplied by the machine
builder before setting `verified` to `true`:

```json
"runtime": {
  "port": 502,
  "unitId": 1,
  "verified": true,
  "fields": {
    "cycleRunning": { "address": 0, "dataType": "uint16", "bitMask": 1, "activeValue": 1, "macro": "F_CYCLESTART" },
    "cyclePaused": { "address": 0, "dataType": "uint16", "bitMask": 1, "activeValue": 1, "macro": "F_PROGHOLD" },
    "currentCycleMs": { "address": 0, "dataType": "float64", "wordOrder": "high-low", "macroNumber": 33564 },
    "currentCuttingMs": { "address": 0, "dataType": "float64", "wordOrder": "high-low", "macroNumber": 33565 },
    "controllerBootCycleMs": { "address": 0, "dataType": "float64", "wordOrder": "high-low", "macroNumber": 33868 },
    "completedParts": { "address": 0, "dataType": "int32", "wordOrder": "high-low", "macroNumber": 33869 },
    "totalCompletedParts": { "address": 0, "dataType": "int32", "wordOrder": "high-low", "macroNumber": 33870 },
    "targetParts": { "address": 0, "dataType": "int32", "wordOrder": "high-low", "macroNumber": 33871 }
  }
}
```

Every `address` above is intentionally `0` as a placeholder; do not enable that
example. A manual verified mapping bypasses autodiscovery. The collector never
sends FTP writes, renames, deletes, SSH/VNC commands, or Modbus write functions.

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

To upgrade an existing installation without replacing its token or controller
mapping, extract the new release and run from an Administrator PowerShell:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\update.ps1
```

The updater preserves `config.json`, tests port 502/mapped values, uploads one
visible snapshot, and then restarts the scheduled task.

Runtime data lives under:

```text
C:\ProgramData\Yingma\MachineWatcher\
```

Daily logs are retained for 14 days. The latest unsent snapshot is retained
as `pending.json` during an internet outage; machine polling continues.

## Diagnostics

```powershell
& 'C:\ProgramData\Yingma\MachineWatcher\YingmaMachineWatcher.ps1' `
  -ConfigPath 'C:\ProgramData\Yingma\MachineWatcher\config.json' -DiscoverRuntime

# Explicit deep survey: read-only full-register diagnostic. Run manually,
# not in the scheduled 15-second loop. It writes a unique verified mapping
# back to config.json when one is found.
& 'C:\ProgramData\Yingma\MachineWatcher\YingmaMachineWatcher.ps1' `
  -ConfigPath 'C:\ProgramData\Yingma\MachineWatcher\config.json' -DeepDiscoverRuntime

& 'C:\ProgramData\Yingma\MachineWatcher\YingmaMachineWatcher.ps1' `
  -ConfigPath 'C:\ProgramData\Yingma\MachineWatcher\config.json' -TestRuntime

& 'C:\ProgramData\Yingma\MachineWatcher\YingmaMachineWatcher.ps1' `
  -ConfigPath 'C:\ProgramData\Yingma\MachineWatcher\config.json' -Once

Get-ScheduledTask -TaskName 'Yingma Machine Watcher'
Get-Content 'C:\ProgramData\Yingma\MachineWatcher\logs\watcher-*.log' -Tail 100
```

## Remove

Run `uninstall.ps1` as Administrator. Add `-RemoveData` to delete configuration,
state, and logs too.
