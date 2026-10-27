<#
.SYNOPSIS
  Removes the OpenBot bench runner from this PC: the scheduled task, the WSL distro "openbot-bench"
  (with its Docker images and job folders), the openbot-bench command and the Desktop shortcuts.
  .wslconfig is left as it is (its backups are next to it). Ask the server admin to revoke the bench:
    sudo python3 /opt/openbot/bench/benchd.py revoke <name>
#>
$ErrorActionPreference = "Continue"
$env:WSL_UTF8 = "1"
$Distro = "openbot-bench"
$Dir = Join-Path $env:LOCALAPPDATA "OpenBotBench"
Stop-ScheduledTask -TaskName "OpenBot Bench" -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName "OpenBot Bench" -Confirm:$false -ErrorAction SilentlyContinue
$answer = Read-Host "Delete the WSL distro $Distro and everything in it? [y/N]"
if ($answer -match "^[yY]") { & wsl.exe --unregister $Distro }
$bin = Join-Path $Dir "bin"
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
[Environment]::SetEnvironmentVariable("Path", (($userPath -split ";" | Where-Object { $_ -and $_ -ne $bin }) -join ";"), "User")
$desktop = [Environment]::GetFolderPath("Desktop")
Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $desktop "OpenBot Bench - pause 2h.cmd"), (Join-Path $desktop "OpenBot Bench - resume.cmd")
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $Dir
Write-Host "Removed. Revoke the bench on the server too: sudo python3 /opt/openbot/bench/benchd.py revoke <name>"
