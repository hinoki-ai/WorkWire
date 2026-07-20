# Complete a staged Windows recovery-agent update from a separate SYSTEM task.
# This script must never run as a child of the agent task being replaced.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$NextRoot,
  [Parameter(Mandatory = $true)][string]$InstallRoot,
  [Parameter(Mandatory = $true)][string]$BackupRoot,
  [Parameter(Mandatory = $true)][string]$ResultPath,
  [string]$TaskName = "WorkWire Recovery Agent",
  [int]$DelaySeconds = 5
)

$ErrorActionPreference = "Stop"
$startedAt = (Get-Date).ToUniversalTime().ToString("o")
$previousMoved = $false
$nextActivated = $false

function Write-Utf8NoBom([string]$Path, [string]$Contents) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
  $temporary = $Path + "." + [guid]::NewGuid().ToString("N") + ".tmp"
  [System.IO.File]::WriteAllText($temporary, $Contents, (New-Object System.Text.UTF8Encoding $false))
  Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Get-AgentProcesses {
  return @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*ww-recovery-agent.mjs*" })
}

function Stop-AgentRuntime {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Get-AgentProcesses | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
  $deadline = (Get-Date).AddSeconds(30)
  do {
    $remaining = Get-AgentProcesses
    if (-not $remaining) { return }
    Start-Sleep -Milliseconds 100
  } while ((Get-Date) -lt $deadline)
  throw "The previous WorkWire recovery agent did not stop within 30 seconds."
}

function Register-AgentTask {
  $agentEntry = Join-Path $InstallRoot "lib\recovery\ww-recovery-agent.mjs"
  $nodePath = Join-Path $InstallRoot "node.exe"
  if (-not (Test-Path -LiteralPath $agentEntry -PathType Leaf) -or
      -not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
    throw "The activated recovery runtime is incomplete."
  }
  $action = New-ScheduledTaskAction -Execute $nodePath -Argument ('"{0}"' -f $agentEntry) -WorkingDirectory $InstallRoot
  $startup = New-ScheduledTaskTrigger -AtStartup
  $watchdog = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(5) `
    -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 3650)
  $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -DontStopOnIdleEnd -StartWhenAvailable `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -MultipleInstances IgnoreNew
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($startup, $watchdog) `
    -Principal $principal -Settings $settings | Out-Null
  Start-ScheduledTask -TaskName $TaskName
}

function Wait-AgentRuntime {
  $expectedNode = (Join-Path $InstallRoot "node.exe").ToLowerInvariant()
  $deadline = (Get-Date).AddSeconds(30)
  do {
    $running = @(Get-AgentProcesses | Where-Object {
      ([string]$_.ExecutablePath).ToLowerInvariant() -eq $expectedNode
    })
    if ($running) { return $running }
    Start-Sleep -Milliseconds 200
  } while ((Get-Date) -lt $deadline)
  throw "The activated WorkWire recovery agent did not start within 30 seconds."
}

if ($DelaySeconds -gt 0) { Start-Sleep -Seconds ([Math]::Min($DelaySeconds, 30)) }

try {
  if (-not (Test-Path -LiteralPath $NextRoot -PathType Container)) {
    throw "The staged recovery runtime is missing: $NextRoot"
  }
  Stop-AgentRuntime
  if (Test-Path -LiteralPath $InstallRoot) {
    Move-Item -LiteralPath $InstallRoot -Destination $BackupRoot
    $previousMoved = $true
  }
  Move-Item -LiteralPath $NextRoot -Destination $InstallRoot
  $nextActivated = $true
  Register-AgentTask
  $running = Wait-AgentRuntime
  $task = Get-ScheduledTask -TaskName $TaskName
  $taskInfo = $task | Get-ScheduledTaskInfo
  $result = [ordered]@{
    ok = $true
    startedAt = $startedAt
    completedAt = (Get-Date).ToUniversalTime().ToString("o")
    installRoot = $InstallRoot
    backupRoot = if ($previousMoved) { $BackupRoot } else { "" }
    agentScriptHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $InstallRoot "lib\recovery\ww-recovery-agent.mjs")).Hash.ToLowerInvariant()
    processIds = @($running | Select-Object -ExpandProperty ProcessId)
    task = [ordered]@{ state = [string]$task.State; lastResult = $taskInfo.LastTaskResult; user = $task.Principal.UserId }
  }
  Write-Utf8NoBom $ResultPath (($result | ConvertTo-Json -Depth 6) + "`n")
  exit 0
} catch {
  $failure = $_
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Get-AgentProcesses | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  if ($nextActivated -and (Test-Path -LiteralPath $InstallRoot)) {
    $failedRoot = $InstallRoot + ".failed." + (Get-Date -Format "yyyyMMdd-HHmmss")
    Move-Item -LiteralPath $InstallRoot -Destination $failedRoot -ErrorAction SilentlyContinue
  }
  if ($previousMoved -and (Test-Path -LiteralPath $BackupRoot) -and -not (Test-Path -LiteralPath $InstallRoot)) {
    Move-Item -LiteralPath $BackupRoot -Destination $InstallRoot -ErrorAction SilentlyContinue
    try { Register-AgentTask } catch {}
  }
  $result = [ordered]@{
    ok = $false
    startedAt = $startedAt
    failedAt = (Get-Date).ToUniversalTime().ToString("o")
    installRoot = $InstallRoot
    stagedRoot = $NextRoot
    backupRoot = $BackupRoot
    rolledBack = $previousMoved -and (Test-Path -LiteralPath $InstallRoot)
    error = [string]$failure.Exception.Message
  }
  Write-Utf8NoBom $ResultPath (($result | ConvertTo-Json -Depth 5) + "`n")
  exit 1
}
