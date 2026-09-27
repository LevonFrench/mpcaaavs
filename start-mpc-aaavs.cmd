@echo off
setlocal
set "PLAYER=%~dp0bin\mpc-hc_x64 Lite\mpc-aaavs.exe"
if not exist "%PLAYER%" (
  echo MPC-AAAVS has not been built. See Readme.md.
  pause
  exit /b 1
)
start "" "%PLAYER%" %*
