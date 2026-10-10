@echo off
rem Restore the original app.asar from the backup taken by apply-core-patch.cmd.
rem Run it, then close DeepSeek Harness completely if it is open.
setlocal
set "NODE_EXE=node"
where node >nul 2>nul || set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
"%NODE_EXE%" "%~dp0apply-installed.mjs" --restore
echo.
pause
