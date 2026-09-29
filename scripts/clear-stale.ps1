# Called by start-partyline.cmd when the line's port is already taken.
# Closing the PartyLine window can leave the server and tunnel running with no window.
# If no other PartyLine window is open, that server is an orphan: stop it so a fresh one can start.
# Exit 0: the port is free now. Exit 1: a live line (its window is still open) owns it.
$port = 8788
$owner = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $owner) { exit 0 }

$myWindow = (Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId
$live = Get-CimInstance Win32_Process -Filter "name='cmd.exe'" |
  Where-Object { $_.ProcessId -ne $myWindow -and $_.CommandLine -like '*start-partyline.cmd*' }
if ($live) { exit 1 }

Write-Host "Clearing a PartyLine server left over from last time..."
$root = Split-Path $PSScriptRoot
Get-CimInstance Win32_Process |
  Where-Object {
    $_.ProcessId -eq $owner.OwningProcess -or
    ($_.Name -eq 'node.exe' -and $_.CommandLine -like "*$root\node_modules*") -or
    ($_.Name -eq 'cloudflared.exe' -and $_.CommandLine -like "*127.0.0.1:$port*")
  } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 500
exit 0
