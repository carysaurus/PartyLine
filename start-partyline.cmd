@echo off
rem Starts PartyLine (server + Cloudflare tunnel) and opens the board.
rem Close this window to shut the line down.
title PartyLine
cd /d "%~dp0"

rem Port taken? Either PartyLine is open in another window, or a server was
rem orphaned when its window closed. clear-stale.ps1 stops orphans.
netstat -ano | findstr /r /c:":8788 .*LISTENING" >nul
if %errorlevel%==0 (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\clear-stale.ps1"
  if errorlevel 1 (
    echo PartyLine is already running. Opening the board...
    start "" http://localhost:8788/
    timeout /t 3 >nul
    exit /b
  )
)

rem Open the board once the server has had a moment to start.
start "" /min cmd /c "timeout /t 4 >nul & start "" http://localhost:8788/"
call npm start
pause
