@echo off
setlocal
set "ROOT=%~dp0"
set "CONFIG=%ROOT%config.json"
if not exist "%CONFIG%" set "ROOT=%ProgramData%\Yingma\MachineWatcher\"
set "CONFIG=%ROOT%config.json"
if not exist "%CONFIG%" (
  echo ERROR: config.json was not found here or in C:\ProgramData\Yingma\MachineWatcher.
  echo Run install.ps1 first.
  pause
  exit /b 1
)
"%WINDIR%\SysWOW64\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ROOT%YingmaMachineWatcher.ps1" -ConfigPath "%CONFIG%" -TestVendor
echo.
echo Test finished. The window will stay open so you can photograph the result.
pause
