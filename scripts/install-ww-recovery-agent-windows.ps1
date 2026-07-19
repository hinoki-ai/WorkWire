# WorkWire recovery agent installer for Windows.
# Run from an elevated PowerShell inside the unpacked bundle directory:
#   powershell -ExecutionPolicy Bypass -File install-ww-recovery-agent-windows.ps1 install -Controller http://192.168.8.104:4852 [-Token TOKEN] [-NodePath C:\path\node.exe]
#   powershell -ExecutionPolicy Bypass -File install-ww-recovery-agent-windows.ps1 status
#   powershell -ExecutionPolicy Bypass -File install-ww-recovery-agent-windows.ps1 uninstall
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet("install", "status", "uninstall")]
  [string]$Command = "status",
  [string]$Controller = "",
  [string]$Token = "",
  [string]$NodePath = ""
)

$ErrorActionPreference = "Stop"
$taskName = "WorkWire Recovery Agent"
$programData = if ($env:ProgramData) { $env:ProgramData } else { "C:\ProgramData" }
$workwireRoot = Join-Path $programData "WorkWire"
$installRoot = Join-Path $workwireRoot "recovery-agent"
$configPath = Join-Path $workwireRoot "recovery-agent.json"
$stateDir = Join-Path $workwireRoot "recovery-state"

function Assert-Administrator {
  $identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  if (-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "This installer must run from an elevated (Administrator) PowerShell."
  }
}

if ($Command -eq "status") {
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if (-not $task) { Write-Output "Not installed: scheduled task '$taskName' does not exist."; exit 1 }
  $info = $task | Get-ScheduledTaskInfo
  Write-Output ("Task state: {0}; last run {1} (result 0x{2:X}); next run {3}" -f $task.State, $info.LastRunTime, $info.LastTaskResult, $info.NextRunTime)
  $agentProcess = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -like "*ww-recovery-agent.mjs*" }
  if ($agentProcess) { Write-Output ("Agent process running: PID {0}" -f ($agentProcess.ProcessId -join ", ")) }
  else { Write-Output "Agent process is not running." }
  exit 0
}

Assert-Administrator

if ($Command -eq "uninstall") {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -like "*ww-recovery-agent.mjs*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $installRoot
  Write-Output "WorkWire recovery agent removed. Config, agent-id, and state under $workwireRoot were preserved."
  exit 0
}

if (-not $Controller) { throw "-Controller URL is required for install." }

# Locate Node.js 22+: explicit -NodePath, a node.exe bundled next to this script, or PATH.
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $NodePath) {
  $bundledNode = Join-Path $scriptRoot "node.exe"
  if (Test-Path $bundledNode) { $NodePath = $bundledNode }
  else {
    $found = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($found) { $NodePath = $found.Source }
  }
}
if (-not $NodePath -or -not (Test-Path $NodePath)) {
  throw "Node.js was not found. Pass -NodePath, place node.exe next to this script, or install Node.js 22+."
}
$nodeMajor = [int](& $NodePath -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 22) { throw "Node.js 22 or newer is required; found $(& $NodePath --version)." }

# Stage the agent files from the bundle (lib\ and node_modules\ws next to this script).
# Remove existing trees first: Copy-Item -Recurse nests the source INSIDE an
# existing destination directory instead of overwriting it.
New-Item -ItemType Directory -Force -Path $installRoot, $stateDir | Out-Null
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $installRoot "lib"), (Join-Path $installRoot "node_modules")
Copy-Item -Recurse -Force (Join-Path $scriptRoot "lib") (Join-Path $installRoot "lib")
New-Item -ItemType Directory -Force -Path (Join-Path $installRoot "node_modules") | Out-Null
Copy-Item -Recurse -Force (Join-Path $scriptRoot "node_modules\ws") (Join-Path $installRoot "node_modules\ws")
Copy-Item -Force (Join-Path $scriptRoot "package.json") (Join-Path $installRoot "package.json")
if ($NodePath -ne (Join-Path $installRoot "node.exe")) {
  Copy-Item -Force $NodePath (Join-Path $installRoot "node.exe")
}

# Write the agent configuration read by resolveRecoveryAgentOptions on win32.
$config = [ordered]@{ controllerUrl = $Controller; token = $Token; mode = "installed" }
# WriteAllText writes UTF-8 without a BOM; Windows PowerShell's Set-Content -Encoding UTF8
# adds one, which the agent's JSON reader must never see.
[System.IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json), (New-Object System.Text.UTF8Encoding $false))

# Register a SYSTEM scheduled task: start at boot, restart forever if the process dies.
# Hibernate/resume keeps the process alive; the agent's own reconnect loop restores the socket.
$agentEntry = Join-Path $installRoot "lib\recovery\ww-recovery-agent.mjs"
$action = New-ScheduledTaskAction -Execute (Join-Path $installRoot "node.exe") -Argument ('"{0}"' -f $agentEntry) -WorkingDirectory $installRoot
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -DontStopOnIdleEnd `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
  -MultipleInstances IgnoreNew
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
Start-ScheduledTask -TaskName $taskName

Write-Output "WorkWire recovery agent installed and started toward $Controller."
Write-Output "State dir: $stateDir  Config: $configPath  Task: '$taskName' (SYSTEM, at startup, auto-restart)."
