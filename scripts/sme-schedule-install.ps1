# scripts/sme-schedule-install.ps1 - register (or remove) the SME runner's
# Windows Scheduled Tasks. Fork (ryvin/u1hub). Run from an elevated or a plain
# PowerShell as the user who is logged on when the printers run:
#
#   powershell -ExecutionPolicy Bypass -File scripts\sme-schedule-install.ps1            # install both tasks
#   powershell -ExecutionPolicy Bypass -File scripts\sme-schedule-install.ps1 -Uninstall # remove them
#   powershell -ExecutionPolicy Bypass -File scripts\sme-schedule-install.ps1 -Status    # show them
#
# Two tasks, both running the runner inside WSL as the current user, only
# while that user is logged on (the Claude subscription login lives in the
# WSL home directory of that user):
#   "U1 Hub SME review"             hourly:  node scripts/sme-runner.js
#   "U1 Hub SME knowledge refresh"  the 1st of every month at 03:30:
#                                   node scripts/sme-runner.js --refresh-knowledge
# The runner holds its own lock, so an overlapping start just exits. A pause
# after a usage limit is the runner's own state file; the tasks keep firing
# and the runner keeps exiting 0 until the pause ends.

[CmdletBinding()]
param(
  [switch]$Uninstall,
  [switch]$Status,
  [string]$RepoLinuxPath = "/mnt/e/Code/u1hub",
  [string]$Distro = "",
  [string]$HourlyName = "U1 Hub SME review",
  [string]$MonthlyName = "U1 Hub SME knowledge refresh"
)

$ErrorActionPreference = "Stop"

function Get-WslArgs([string]$cmd) {
  $a = @()
  if ($Distro) { $a += @("-d", $Distro) }
  $a += @("-e", "bash", "-lc", ('cd ' + $RepoLinuxPath + ' && ' + $cmd))
  return ($a | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join " "
}

if ($Status) {
  foreach ($n in @($HourlyName, $MonthlyName)) {
    $t = Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue
    if ($t) { $i = Get-ScheduledTaskInfo -TaskName $n; Write-Host ("{0}: {1}, last run {2} (result {3}), next {4}" -f $n, $t.State, $i.LastRunTime, $i.LastTaskResult, $i.NextRunTime) }
    else { Write-Host ("{0}: not installed" -f $n) }
  }
  exit 0
}

if ($Uninstall) {
  foreach ($n in @($HourlyName, $MonthlyName)) {
    if (Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $n -Confirm:$false; Write-Host ("removed: {0}" -f $n) }
    else { Write-Host ("not installed: {0}" -f $n) }
  }
  exit 0
}

$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 3) -MultipleInstances IgnoreNew -StartWhenAvailable -RunOnlyIfNetworkAvailable

# Hourly review: a daily trigger that repeats every hour, indefinitely.
$hourlyAction = New-ScheduledTaskAction -Execute "wsl.exe" -Argument (Get-WslArgs "node scripts/sme-runner.js")
$hourlyTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddMinutes(15) -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration ([TimeSpan]::MaxValue)
if (Get-ScheduledTask -TaskName $HourlyName -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $HourlyName -Confirm:$false }
Register-ScheduledTask -TaskName $HourlyName -Action $hourlyAction -Trigger $hourlyTrigger -Principal $principal -Settings $settings -Description "Reviews the next few gcode / 3MF / printer targets with Claude Code on the owner's subscription (scripts/sme-runner.js). Advice only; nothing is applied." | Out-Null
Write-Host ("installed: {0} (hourly, as {1}, only when logged on)" -f $HourlyName, $user)

# Monthly knowledge refresh: the 1st of every month at 03:30. New-ScheduledTaskTrigger
# has no -Monthly parameter, so the trigger is built from the CIM class directly.
$monthlyAction = New-ScheduledTaskAction -Execute "wsl.exe" -Argument (Get-WslArgs "node scripts/sme-runner.js --refresh-knowledge")
$class = Get-CimClass -ClassName MSFT_TaskMonthlyTrigger -Namespace Root/Microsoft/Windows/TaskScheduler
$monthlyTrigger = New-CimInstance -CimClass $class -ClientOnly
$monthlyTrigger.DaysOfMonth = 1
$monthlyTrigger.MonthsOfYear = 4095        # bitmask: all twelve months
$monthlyTrigger.StartBoundary = (Get-Date -Date (Get-Date).Date.AddHours(3).AddMinutes(30)).ToString("yyyy-MM-ddTHH:mm:ss")
$monthlyTrigger.Enabled = $true
if (Get-ScheduledTask -TaskName $MonthlyName -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $MonthlyName -Confirm:$false }
Register-ScheduledTask -TaskName $MonthlyName -Action $monthlyAction -Trigger $monthlyTrigger -Principal $principal -Settings $settings -Description "Rewrites sme/knowledge.md with fresh web research (Claude Code, web tools on). The old file is kept as knowledge.md.bak." | Out-Null
Write-Host ("installed: {0} (1st of the month 03:30, as {1}, only when logged on)" -f $MonthlyName, $user)
Write-Host "Check: powershell -File scripts\sme-schedule-install.ps1 -Status   |   log: sme-runner.log in the repo"
