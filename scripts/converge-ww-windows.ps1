# Agent-only, idempotent convergence for a WorkWire Windows workstation.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$SourceArchive,
  [Parameter(Mandatory = $true)][string]$PairingTokenFile,
  [Parameter(Mandatory = $true)][string]$ControllerUrl,
  [Parameter(Mandatory = $true)][string]$PeerHost,
  [Parameter(Mandatory = $true)][string]$PeerMachineId,
  [Parameter(Mandatory = $true)][string]$ExpectedServiceId,
  [string]$PeerRoot = "/home/hinoki/WorkWire",
  [string]$PortalRoot = "C:\Users\Sakura\WorkWire",
  [string]$UserProfilePath = "C:\Users\Sakura",
  [string]$UserName = "Sakura",
  [string]$NodePath = "C:\ProgramData\WorkWire\recovery-agent\node.exe",
  [string]$ReferenceUtc = "",
  [string]$TimeZoneId = "Pacific SA Standard Time",
  [switch]$RepairClock
)

$ErrorActionPreference = "Stop"
$taskName = "WorkWire Serve"
$programDataRoot = Join-Path $env:ProgramData "WorkWire"
$stagingRoot = Join-Path $programDataRoot ("source-stage-" + [guid]::NewGuid().ToString("N"))
$backupRoot = Join-Path $programDataRoot ("backups\source-" + (Get-Date -Format "yyyyMMdd-HHmmss") + "-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
$manifestName = ".workwire-deploy-manifest.json"
$maintenanceMarker = Join-Path $programDataRoot "file-service-maintenance.lock"

function Assert-Administrator {
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Windows convergence requires Administrator or SYSTEM."
  }
}

function Write-Utf8NoBom([string]$Path, [string]$Contents) {
  $parent = Split-Path -Parent $Path
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  [System.IO.File]::WriteAllText($Path, $Contents, (New-Object System.Text.UTF8Encoding $false))
}

function Stop-WorkWireRuntime {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  $escapedRoot = [regex]::Escape($PortalRoot)
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match $escapedRoot -and $_.CommandLine -match "ww\.mjs" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Get-Process WorkWire -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -like (Join-Path $UserProfilePath "AppData\Local\WorkWire\app\*") } |
    Stop-Process -Force -ErrorAction SilentlyContinue
}

function Repair-WindowsClock {
  if (-not $RepairClock) { return }
  if (-not $ReferenceUtc) { throw "-ReferenceUtc is required with -RepairClock." }
  $zone = Get-TimeZone -ListAvailable | Where-Object { $_.Id -eq $TimeZoneId } | Select-Object -First 1
  if (-not $zone) { throw "Windows time zone '$TimeZoneId' is unavailable." }
  Set-TimeZone -Id $TimeZoneId
  New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\TimeZoneInformation" `
    -Name RealTimeIsUniversal -PropertyType DWord -Value 1 -Force | Out-Null
  $reference = [DateTimeOffset]::Parse($ReferenceUtc)
  $localReference = [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId($reference, $TimeZoneId).DateTime
  Set-Date -Date $localReference | Out-Null
  & sc.exe config w32time start= auto | Out-Null
  Start-Service w32time -ErrorAction SilentlyContinue
  & w32tm.exe /config /manualpeerlist:"time.windows.com,0x9" /syncfromflags:manual /update | Out-Null
  & w32tm.exe /resync /force | Out-Null
}

function Copy-CanonicalSource($Manifest) {
  foreach ($relativeValue in $Manifest.files) {
    $relative = [string]$relativeValue
    $windowsRelative = $relative.Replace("/", "\")
    $source = Join-Path $stagingRoot $windowsRelative
    $destination = Join-Path $PortalRoot $windowsRelative
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Archive entry is missing: $relative" }
    if (Test-Path -LiteralPath $destination -PathType Leaf) {
      $backup = Join-Path $backupRoot ("overwritten\" + $windowsRelative)
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $backup) | Out-Null
      Copy-Item -LiteralPath $destination -Destination $backup -Force
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination -Force
  }
}

function Read-SourceRelease {
  $inspector = Join-Path $PortalRoot "scripts\inspect-ww-source.mjs"
  $raw = & $NodePath $inspector
  if ($LASTEXITCODE -ne 0) { throw "WorkWire source inspector exited $LASTEXITCODE." }
  return ($raw | Out-String | ConvertFrom-Json)
}

function Reconcile-ReleaseExtras($Manifest) {
  $expected = @{}
  foreach ($relative in $Manifest.release.files) { $expected[[string]$relative] = $true }
  $actual = Read-SourceRelease
  $extras = @($actual.files | Where-Object { -not $expected.ContainsKey([string]$_) })
  foreach ($relativeValue in $extras) {
    $relative = [string]$relativeValue
    $source = Join-Path $PortalRoot $relative.Replace("/", "\")
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { continue }
    $backup = Join-Path $backupRoot ("release-extras\" + $relative.Replace("/", "\"))
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $backup) | Out-Null
    Move-Item -LiteralPath $source -Destination $backup -Force
  }
  $verified = Read-SourceRelease
  if ($verified.hash -ne $Manifest.release.hash -or $verified.updateHash -ne $Manifest.release.updateHash) {
    throw "Canonical source hash mismatch after convergence: expected $($Manifest.release.version), found $($verified.version)."
  }
  return $verified
}

function Configure-RecoveryClient {
  $stateDir = Join-Path $UserProfilePath ".config\workwire\recovery"
  $configPath = Join-Path $stateDir "controller.json"
  $extensions = [ordered]@{ clientUrl = $ControllerUrl }
  if (Test-Path -LiteralPath $configPath) {
    $previous = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    if ($previous.extensions) {
      foreach ($property in $previous.extensions.PSObject.Properties) {
        if ($property.Name -ne "clientUrl") { $extensions[$property.Name] = $property.Value }
      }
    }
  }
  $config = [ordered]@{
    version = 1; enabled = $false; host = "127.0.0.1"; port = 4852
    bootHost = "127.0.0.1"; bootPort = 4853; advertisedHost = ""; token = ""
    stateDir = $stateDir; heartbeatMs = 5000; staleAfterMs = 15000; offlineAfterMs = 30000
    jobLeaseMs = 30000; maxJsonBytes = 4194304; maxArtifactBytes = 0
    planner = [ordered]@{ enabled = $false; command = @(); maxIterations = 100; iterationTimeoutMs = 1800000 }
    pxe = [ordered]@{ enabled = $false; interface = ""; proxyDhcp = $true; tftpRoot = (Join-Path $stateDir "boot\ipxe"); bootRoot = (Join-Path $stateDir "boot") }
    extensions = $extensions
  }
  Write-Utf8NoBom $configPath (($config | ConvertTo-Json -Depth 8) + "`n")
  [Environment]::SetEnvironmentVariable("WW_RECOVERY_CONTROLLER_URL", $ControllerUrl, "Machine")
}

function Configure-FilePeer {
  $configDir = Join-Path $UserProfilePath ".config\workwire"
  $script = Join-Path $PortalRoot "scripts\converge-ww-peer.mjs"
  $arguments = @(
    $script,
    "--config-dir", $configDir,
    "--portal", $PortalRoot,
    "--token-file", $PairingTokenFile,
    "--expect-service-id", $ExpectedServiceId,
    "--service-name", "Sakura",
    "--peer-label", "HINOKI",
    "--peer-host", $PeerHost,
    "--peer-port", "4851",
    "--peer-id", $PeerMachineId,
    "--peer-root", $PeerRoot,
    "--consume-token-file"
  )
  $result = & $NodePath @arguments
  if ($LASTEXITCODE -ne 0) { throw "WorkWire peer convergence exited $LASTEXITCODE." }
  return ($result | Out-String | ConvertFrom-Json)
}

function Repair-DesktopInstall {
  $appRoot = Join-Path $UserProfilePath "AppData\Local\WorkWire\app"
  $executable = Join-Path $appRoot "WorkWire.exe"
  if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw "Installed WorkWire.exe is missing at $executable." }
  $resourceApp = Join-Path $appRoot "resources\app"
  $resource = Get-Item -LiteralPath $resourceApp -Force -ErrorAction SilentlyContinue
  $targetsPortal = $resource -and $resource.LinkType -eq "Junction" -and @($resource.Target) -contains $PortalRoot
  if (-not $targetsPortal) {
    if ($resource) {
      $backup = Join-Path $backupRoot "desktop-resource-app"
      Move-Item -LiteralPath $resourceApp -Destination $backup -Force
    }
    New-Item -ItemType Junction -Path $resourceApp -Target $PortalRoot | Out-Null
  }
  $shell = New-Object -ComObject WScript.Shell
  $shortcutSpecs = @(
    (Join-Path $UserProfilePath "Desktop\WorkWire.lnk"),
    (Join-Path $UserProfilePath "AppData\Roaming\Microsoft\Windows\Start Menu\Programs\WorkWire.lnk")
  )
  foreach ($shortcutPath in $shortcutSpecs) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $shortcutPath) | Out-Null
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $executable
    $shortcut.WorkingDirectory = $appRoot
    $shortcut.IconLocation = (Join-Path $appRoot "WorkWire.ico") + ",0"
    $shortcut.Save()
  }
}

function Register-ServeTask {
  $entry = Join-Path $PortalRoot "ww.mjs"
  # Tiny-file batches issue many independent filesystem operations.  Set the
  # Node pool before process start so NTFS opens/writes can overlap instead of
  # being serialized through Node's four-worker default.
  # Keep the interactive cmd.exe service console readable: UTF-8 makes the
  # shared Unicode panel render correctly, and the title identifies the peer
  # instead of leaving the window labelled only "cmd.exe".
  $consoleTitle = "WorkWire - {0} Service" -f ($UserName -replace '[^A-Za-z0-9 _-]', '')
  $command = 'chcp 65001>nul&&title {0}&&set UV_THREADPOOL_SIZE=32&&"{1}" "{2}" serve' -f $consoleTitle, $NodePath, $entry
  $action = New-ScheduledTaskAction -Execute $env:ComSpec -Argument ('/d /s /c "{0}"' -f $command) -WorkingDirectory $PortalRoot
  $logon = New-ScheduledTaskTrigger -AtLogOn -User $UserName
  $watchdog = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(5) `
    -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 3650)
  $principal = New-ScheduledTaskPrincipal -UserId ("{0}\{1}" -f $env:COMPUTERNAME, $UserName) -LogonType Interactive -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -DontStopOnIdleEnd -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -MultipleInstances IgnoreNew
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($logon, $watchdog) `
    -Principal $principal -Settings $settings | Out-Null
  Start-ScheduledTask -TaskName $taskName
}

function Wait-ForFileService {
  $deadline = (Get-Date).AddSeconds(90)
  do {
    try {
      return Invoke-RestMethod -Uri "http://127.0.0.1:4851/v1/discover" -TimeoutSec 3
    } catch {
      Start-Sleep -Milliseconds 500
    }
  } while ((Get-Date) -lt $deadline)
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  $info = if ($task) { $task | Get-ScheduledTaskInfo } else { $null }
  throw "WorkWire file service did not listen within 90 seconds; task state=$($task.State), result=$($info.LastTaskResult)."
}

Assert-Administrator
foreach ($requiredPath in @($SourceArchive, $PairingTokenFile, $NodePath)) {
  if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) { throw "Required file is missing: $requiredPath" }
}
New-Item -ItemType Directory -Force -Path $programDataRoot, $stagingRoot, $backupRoot, $PortalRoot | Out-Null
Write-Utf8NoBom $maintenanceMarker ((Get-Date).ToUniversalTime().ToString("o") + "`n")
try {
  Repair-WindowsClock
  Stop-WorkWireRuntime
  & tar.exe -xzf $SourceArchive -C $stagingRoot
  if ($LASTEXITCODE -ne 0) { throw "tar.exe exited $LASTEXITCODE while extracting source." }
  $manifestPath = Join-Path $stagingRoot $manifestName
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  if ($manifest.schema -ne "workwire-source-deployment/v1") { throw "Unsupported WorkWire source manifest." }
  Copy-CanonicalSource $manifest
  $release = Reconcile-ReleaseExtras $manifest
  $peer = Configure-FilePeer
  Configure-RecoveryClient
  Repair-DesktopInstall
  $existingRule = Get-NetFirewallRule -DisplayName "WorkWire File Service" -ErrorAction SilentlyContinue
  if (-not $existingRule) {
    New-NetFirewallRule -DisplayName "WorkWire File Service" -Direction Inbound -Action Allow `
      -Protocol TCP -LocalPort 4851 -Profile Any | Out-Null
  } else {
    $existingRule | Set-NetFirewallRule -Enabled True -Action Allow -Profile Any
  }
  $beaconRule = Get-NetFirewallRule -DisplayName "WorkWire LAN Beacon" -ErrorAction SilentlyContinue
  if (-not $beaconRule) {
    New-NetFirewallRule -DisplayName "WorkWire LAN Beacon" -Direction Inbound -Action Allow `
      -Protocol UDP -LocalPort 9001-9002 -Profile Any | Out-Null
  } else {
    $beaconRule | Set-NetFirewallRule -Enabled True -Action Allow -Profile Any
  }
  Register-ServeTask
  $discover = Wait-ForFileService
  $task = Get-ScheduledTask -TaskName $taskName
  $taskInfo = $task | Get-ScheduledTaskInfo
  [ordered]@{
    ok = $true
    release = [ordered]@{ version = $release.version; hash = $release.hash; updateHash = $release.updateHash }
    service = $discover.service
    peer = $peer.peer
    recoveryController = $ControllerUrl
    task = [ordered]@{ state = [string]$task.State; lastResult = $taskInfo.LastTaskResult; user = $task.Principal.UserId; runLevel = [string]$task.Principal.RunLevel }
    clock = [ordered]@{ now = (Get-Date).ToString("o"); utc = (Get-Date).ToUniversalTime().ToString("o"); timeZone = (Get-TimeZone).Id }
    backupRoot = $backupRoot
  } | ConvertTo-Json -Depth 8 -Compress
} finally {
  Remove-Item -LiteralPath $maintenanceMarker -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $stagingRoot -Recurse -Force -ErrorAction SilentlyContinue
}
