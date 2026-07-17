@echo off
setlocal
fltmc >nul 2>&1
if not %errorlevel%==0 (
  powershell.exe -NoLogo -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
if not exist "%~dp0factory.token" (
  echo ERROR: factory.token is missing from this private factory package.
  pause
  exit /b 1
)
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$t=(Get-Content -LiteralPath '%~dp0factory.token' -Raw).Trim(); & '%~dp0install.ps1' -Token $t"
echo.
if not %errorlevel%==0 (
  echo INSTALL FAILED. Photograph this window and send it to support.
) else (
  echo INSTALL COMPLETE. The collector now starts with Windows, without login.
  echo Open https://yingma.siyue.ai/machines
)
pause
