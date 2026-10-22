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
#   "U1 Hub SME review"             daily at 02:50 (-Every hourly: every hour at :50):
#                                   node scripts/sme-runner.js
#   "U1 Hub SME knowledge refresh"  the 1st of every month at 03:50:
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
  [string]$MonthlyName = "U1 Hub SME knowledge refresh",
  # "daily" since 2026-10-21 (the owner wanted the SME once a day); "hourly"
  # is the 2026-10-04..10-21 schedule.
  [ValidateSet("daily", "hourly")] [string]$Every = "daily",
  # Time of the daily run (local, HH:mm). Before the 03:50 knowledge refresh.
  [string]$At = "02:50",
  # Reviews per run. Default 4 for the daily run (the runner's by-hand batch);
  # 1 for hourly (2026-10-05: 24 a day at most, to save tokens).
  [int]$Batch = 0
)
if ($Batch -le 0) { $Batch = if ($Every -eq "daily") { 4 } else { 1 } }

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

# Review: once a day at $At, or (-Every hourly) a trigger that repeats every
# hour, indefinitely. StartWhenAvailable runs a missed daily start at the next logon.
$hourlyAction = New-ScheduledTaskAction -Execute "wsl.exe" -Argument (Get-WslArgs ("SME_BATCH=" + $Batch + " node scripts/sme-runner.js"))
if ($Every -eq "daily") {
  $hourlyTrigger = New-ScheduledTaskTrigger -Daily -At ([datetime]::ParseExact($At, "HH:mm", $null))
} else {
  $hourlyTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddMinutes(50) -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration (New-TimeSpan -Days 3650)   # [TimeSpan]::MaxValue is rejected: HRESULT 0x80041318, Duration P99999999D... (measured 2026-10-04)
}
if (Get-ScheduledTask -TaskName $HourlyName -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $HourlyName -Confirm:$false }
Register-ScheduledTask -TaskName $HourlyName -Action $hourlyAction -Trigger $hourlyTrigger -Principal $principal -Settings $settings -Description "Reviews the next few gcode / 3MF / printer targets with Claude Code on the owner's subscription (scripts/sme-runner.js). Advice only; nothing is applied." | Out-Null
$when = if ($Every -eq "daily") { "daily at " + $At } else { "hourly" }
Write-Host ("installed: {0} ({1}, {2} per run, as {3}, only when logged on)" -f $HourlyName, $when, $Batch, $user)

# Monthly knowledge refresh: the 1st of every month at 03:50. New-ScheduledTaskTrigger
# has no -Monthly parameter, and the CIM MSFT_TaskMonthlyTrigger class on this
# Windows build has no MonthsOfYear property (measured 2026-10-04), so the task
# is registered with a daily trigger and its XML is then rewritten to a
# monthly calendar trigger (day 1, every month). schtasks.exe /SC MONTHLY was
# tried and mangles the quoted wsl.exe argument list.
if (Get-ScheduledTask -TaskName $MonthlyName -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $MonthlyName -Confirm:$false }
$monthlyAction = New-ScheduledTaskAction -Execute "wsl.exe" -Argument (Get-WslArgs "node scripts/sme-runner.js --refresh-knowledge")
$seedTrigger = New-ScheduledTaskTrigger -Daily -At ((Get-Date).Date.AddHours(3).AddMinutes(50))
Register-ScheduledTask -TaskName $MonthlyName -Action $monthlyAction -Trigger $seedTrigger -Principal $principal -Settings $settings -Description "Rewrites sme/knowledge.md with fresh web research (Claude Code, web tools on). The old file is kept as knowledge.md.bak." | Out-Null
$xml = Export-ScheduledTask -TaskName $MonthlyName
$months = "<Months>" + ((@("January","February","March","April","May","June","July","August","September","October","November","December") | ForEach-Object { "<$_ />" }) -join "") + "</Months>"
$xml = [regex]::Replace($xml, "<ScheduleByDay>[\s\S]*?</ScheduleByDay>", ("<ScheduleByMonth><DaysOfMonth><Day>1</Day></DaysOfMonth>" + $months + "</ScheduleByMonth>"))
if ($xml -notmatch "<ScheduleByMonth>") { throw "could not rewrite the trigger to monthly" }
Unregister-ScheduledTask -TaskName $MonthlyName -Confirm:$false
Register-ScheduledTask -TaskName $MonthlyName -Xml $xml | Out-Null
Write-Host ("installed: {0} (1st of the month 03:50, as {1}, only when logged on)" -f $MonthlyName, $user)
Write-Host "Check: powershell -File scripts\sme-schedule-install.ps1 -Status   |   log: sme-runner.log in the repo"
