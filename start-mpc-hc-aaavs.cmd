@echo off
setlocal
set "PLAYER=%~dp0bin\mpc-hc_x64 Lite\mpc-hc-aaavs.exe"
if not exist "%PLAYER%" (
  echo mpc-hc-aaavs has not been built. See Readme.md.
  pause
  exit /b 1
)
start "" "%PLAYER%" %*
