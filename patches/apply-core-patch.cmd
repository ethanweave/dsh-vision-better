@echo off
rem Apply the session/image-admission core extension to the installed
rem DeepSeek Harness desktop app. Run it, then close DeepSeek Harness
rem completely (if it is open); this window finishes the swap and says so.
rem Restore with:  restore-core-patch.cmd
setlocal
set "NODE_EXE=node"
where node >nul 2>nul || set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
"%NODE_EXE%" "%~dp0apply-installed.mjs" --apply
echo.
pause
