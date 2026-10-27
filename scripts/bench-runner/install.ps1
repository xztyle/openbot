<#
.SYNOPSIS
  Installs the OpenBot bench runner on this Windows PC: a dedicated WSL2 distro "openbot-bench"
  (Ubuntu 24.04) with Docker Engine and the NVIDIA Container Toolkit, started hidden at logon.

.DESCRIPTION
  Run once, in a normal (not administrator) PowerShell window:
    powershell -ExecutionPolicy Bypass -File install.ps1
  It asks for the server URL and the one-time enrollment code. Running it again updates the runner
  and keeps the enrollment (pass -Code only to enroll again after a revoke).
#>
param(
    [string]$Server = "",
    [string]$Code = "",
    [switch]$SkipWslConfig
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$env:WSL_UTF8 = "1"
$Distro = "openbot-bench"
$Dir = Join-Path $env:LOCALAPPDATA "OpenBotBench"
$TaskName = "OpenBot Bench"

function Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }
function Wsl([string[]]$WslArgs) {
    & wsl.exe @WslArgs
    if ($LASTEXITCODE -ne 0) { throw "wsl $($WslArgs -join ' ') failed (exit $LASTEXITCODE)" }
}
function InDistro([string]$User, [string[]]$Command) { Wsl (@("-d", $Distro, "-u", $User, "--") + $Command) }

# ---- inputs ----------------------------------------------------------------------------------
if (-not $Server) { $Server = Read-Host "Server URL (for example https://bench.delynith.com)" }
$Server = $Server.Trim().TrimEnd("/")
if (-not $Server.StartsWith("https://")) { throw "The server URL must start with https://" }

# ---- WSL -------------------------------------------------------------------------------------
Step "Checking WSL"
& wsl.exe --status *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Host "WSL is not installed. In an administrator PowerShell run:  wsl --install --no-distribution"
    Write-Host "then restart Windows and run this installer again."
    exit 1
}
& wsl.exe --update 2>&1 | Out-Host

# ---- runner files ----------------------------------------------------------------------------
Step "Downloading the runner from $Server"
$Bundle = Join-Path $Dir "bundle"
if (Test-Path $Bundle) { Remove-Item -Recurse -Force $Bundle }
New-Item -ItemType Directory -Force $Bundle | Out-Null
$manifest = Invoke-RestMethod -UseBasicParsing "$Server/v1/dist/manifest.json"
foreach ($entry in $manifest.files.PSObject.Properties) {
    $rel = $entry.Name
    $dest = Join-Path $Bundle ($rel -replace "/", "\")
    New-Item -ItemType Directory -Force (Split-Path $dest) | Out-Null
    Invoke-WebRequest -UseBasicParsing "$Server/v1/dist/$rel" -OutFile $dest
    if ((Get-FileHash $dest -Algorithm SHA256).Hash.ToLower() -ne $entry.Value) { throw "Checksum mismatch for $rel" }
}
Write-Host "$(@($manifest.files.PSObject.Properties).Count) files"

# ---- distro ----------------------------------------------------------------------------------
Step "Creating the WSL distro $Distro (Ubuntu 24.04)"
$existing = @(& wsl.exe -l -q) | ForEach-Object { $_.Trim() } | Where-Object { $_ -eq $Distro }
if ($existing) {
    Write-Host "$Distro already exists; updating it."
} else {
    Wsl @("--install", "Ubuntu-24.04", "--name", $Distro, "--no-launch")
}
$BundleWsl = (& wsl.exe -d $Distro -u root -- wslpath -a ($Bundle -replace "\\", "/")).Trim()
Step "Installing Docker Engine and the NVIDIA Container Toolkit inside $Distro (a few minutes)"
InDistro "root" @("bash", "$BundleWsl/setup-distro.sh", "base", $BundleWsl)

# ---- .wslconfig ------------------------------------------------------------------------------
$WslConfigChanged = $false
if (-not $SkipWslConfig) {
    Step "WSL resource limits (%UserProfile%\.wslconfig)"
    $half = [math]::Max(2, [math]::Floor([Environment]::ProcessorCount / 2))
    $want = [ordered]@{ "memory" = "32GB"; "processors" = "$half" }
    $path = Join-Path $env:USERPROFILE ".wslconfig"
    $old = @(); if (Test-Path $path) { $old = @(Get-Content $path) }
    $new = New-Object System.Collections.Generic.List[string]
    $section = ""; $seen = @{}; $hasWsl2 = $false
    foreach ($line in $old) {
        $t = $line.Trim()
        if ($t -match "^\[(.+)\]$") {
            if ($section -eq "wsl2") { foreach ($k in $want.Keys) { if (-not $seen[$k]) { $new.Add("$k=$($want[$k])"); $seen[$k] = $true } } }
            $section = $Matches[1].Trim().ToLower(); if ($section -eq "wsl2") { $hasWsl2 = $true }
            $new.Add($line); continue
        }
        if ($section -eq "wsl2" -and $t -match "^([A-Za-z]+)\s*=") {
            $k = $Matches[1].ToLower()
            if ($want.Contains($k)) { $new.Add("$k=$($want[$k])"); $seen[$k] = $true; continue }
        }
        $new.Add($line)
    }
    if ($section -eq "wsl2") { foreach ($k in $want.Keys) { if (-not $seen[$k]) { $new.Add("$k=$($want[$k])"); $seen[$k] = $true } } }
    if (-not $hasWsl2) { $new.Add("[wsl2]"); foreach ($k in $want.Keys) { $new.Add("$k=$($want[$k])") } }
    if ((($old -join "`n").Trim()) -eq (($new -join "`n").Trim())) {
        Write-Host ".wslconfig already has memory=32GB and processors=$half."
    } else {
        Write-Host "Proposed change. It applies to ALL WSL distros on this PC (Docker Desktop and others too):"
        Write-Host "---- current ----"; if ($old.Count) { $old | Out-Host } else { Write-Host "(no file)" }
        Write-Host "---- new ----"; $new | Out-Host
        $answer = Read-Host "Write this .wslconfig? A backup of the current file is kept. [y/N]"
        if ($answer -match "^[yY]") {
            if (Test-Path $path) { Copy-Item $path "$path.bak-$(Get-Date -Format yyyyMMdd-HHmmss)" }
            [IO.File]::WriteAllLines($path, $new)
            $WslConfigChanged = $true
            Write-Host "Written."
        } else {
            Write-Host "Skipped. The bench then uses WSL's defaults (half the RAM, all cores)."
        }
    }
}

# ---- restart the distro with systemd ---------------------------------------------------------
Step "Starting $Distro with systemd"
if ($WslConfigChanged) {
    $answer = Read-Host "The new limits apply after 'wsl --shutdown', which stops ALL running WSL distros now. Do it? [y/N]"
    if ($answer -match "^[yY]") { & wsl.exe --shutdown } else {
        Write-Host "Not now: the limits apply after the next Windows restart or 'wsl --shutdown'."
        & wsl.exe --terminate $Distro
    }
} else {
    & wsl.exe --terminate $Distro
}
Start-Sleep -Seconds 3
InDistro "root" @("/opt/openbot-bench/setup-distro.sh", "check")

# ---- enrollment ------------------------------------------------------------------------------
& wsl.exe -d $Distro -u bench -- test -f /var/lib/openbot-bench/config.json
$enrolled = ($LASTEXITCODE -eq 0)
if (-not $enrolled -or $Code) {
    Step "Enrolling this PC"
    if (-not $Code) { $Code = Read-Host "Enrollment code (from the server admin)" }
    InDistro "bench" @("python3", "/opt/openbot-bench/runner.py", "enroll", "--server", $Server, "--code", $Code.Trim())
} else {
    Write-Host "`nAlready enrolled; keeping the existing bench secret."
}

# ---- images ----------------------------------------------------------------------------------
Step "Building the job images (first time: 5-15 minutes)"
InDistro "bench" @("python3", "/opt/openbot-bench/runner.py", "sync-images")
Step "GPU check"
& wsl.exe -d $Distro -u bench -- docker run --rm --gpus all openbot-bench/base:1 nvidia-smi -L
if ($LASTEXITCODE -ne 0) { Write-Host "GPU containers do not work yet; the bench still takes CPU jobs." -ForegroundColor Yellow }

# ---- background task and shortcuts -----------------------------------------------------------
Step "Starting the runner hidden at every logon"
$action = New-ScheduledTaskAction -Execute "conhost.exe" `
    -Argument "--headless wsl.exe -d $Distro -u bench -- /opt/openbot-bench/run-runner.sh"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -Hidden -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -MultipleInstances IgnoreNew `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -Priority 7
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -Principal $principal -Description "OpenBot bench runner (WSL distro $Distro)" -Force | Out-Null
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName $TaskName

$bin = Join-Path $Dir "bin"
New-Item -ItemType Directory -Force $bin | Out-Null
Set-Content -Encoding ASCII (Join-Path $bin "openbot-bench.cmd") "@echo off`r`nwsl.exe -d $Distro -u bench -- python3 /opt/openbot-bench/runner.py %*"
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not ($userPath -split ";" | Where-Object { $_ -eq $bin })) {
    [Environment]::SetEnvironmentVariable("Path", (($userPath.TrimEnd(";"), $bin) -join ";").TrimStart(";"), "User")
}
$desktop = [Environment]::GetFolderPath("Desktop")
Set-Content -Encoding ASCII (Join-Path $desktop "OpenBot Bench - pause 2h.cmd") "@echo off`r`nwsl.exe -d $Distro -u bench -- python3 /opt/openbot-bench/runner.py pause 2h`r`ntimeout /t 5"
Set-Content -Encoding ASCII (Join-Path $desktop "OpenBot Bench - resume.cmd") "@echo off`r`nwsl.exe -d $Distro -u bench -- python3 /opt/openbot-bench/runner.py resume`r`ntimeout /t 5"

Start-Sleep -Seconds 8
Step "Status"
& wsl.exe -d $Distro -u bench -- python3 /opt/openbot-bench/runner.py status
Write-Host @"

Done. The bench runs hidden whenever you are logged on.
  openbot-bench pause 2h | pause | resume | status     (new terminal windows; or the Desktop shortcuts)
  Log: wsl -d $Distro -- tail -f /var/lib/openbot-bench/runner.log
  Remove: powershell -ExecutionPolicy Bypass -File "$Bundle\uninstall.ps1"
"@
