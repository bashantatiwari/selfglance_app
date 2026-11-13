# Turns Bond's log into a table of guide steps: how long each took, what he picked, and what you did.
#
#   powershell -File scripts\guide-report.ps1                 # the last guided job
#   powershell -File scripts\guide-report.ps1 -Jobs 3         # the last three
#   powershell -File scripts\guide-report.ps1 -Since "19:50"  # everything from a time today
#
# A "job" is a run of guide steps with no gap longer than -GapMinutes (default 3).
param(
    [int]$Jobs = 1,
    [string]$Since = "",
    [int]$GapMinutes = 3,
    [string]$Log = "$env:APPDATA\com.selfglance.app\logs\bond.log"
)

$lines = Get-Content -Path $Log -Encoding UTF8
$stamp = '^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}) '
$steps = @()
$voice = @{}   # time of a guide line -> first-sound delay that followed it
$last = $null
foreach ($l in $lines) {
    if ($l -notmatch $stamp) { continue }
    $t = [datetime]::ParseExact($Matches[1], 'yyyy-MM-dd HH:mm:ss.fff', $null)
    if ($Since -and $t.ToString('yyyy-MM-dd') -eq (Get-Date).ToString('yyyy-MM-dd') -and $t.ToString('HH:mm') -lt $Since) { continue }
    if ($l -match 'guide: (click|type|wait|done) .*? picked (.*?); (\d+) controls shown; ([\d.]+)s( \(text only\))?') {
        $last = [pscustomobject]@{
            Time = $t; Step = $Matches[1]; Picked = $Matches[2]; Controls = [int]$Matches[3]; Model = [double]$Matches[4]
            TextOnly = [bool]$Matches[5]; Outcome = ''; Settle = $null; Voice = $null
        }
        $steps += $last
    }
    elseif ($last -and $l -match 'guide: (followed|elsewhere|timeout)') { $last.Outcome = $Matches[1] }
    elseif ($last -and $l -match 'guide: settled after (\d+) ms') { $last.Settle = [int]$Matches[1] / 1000 }
    elseif ($last -and $l -match 'voice: first sound ready (\d+) ms' -and $null -eq $last.Voice) { $last.Voice = [int]$Matches[1] / 1000 }
}
if (-not $steps) { Write-Host "No guide steps in the log (after $Since)."; return }

# Split into jobs by gaps, keep the last N.
$groups = @(); $cur = @($steps[0])
for ($i = 1; $i -lt $steps.Count; $i++) {
    if (($steps[$i].Time - $steps[$i - 1].Time).TotalMinutes -gt $GapMinutes) { $groups += , $cur; $cur = @() }
    $cur += $steps[$i]
}
$groups += , $cur
$first = [math]::Max(0, $groups.Count - $Jobs)

for ($gi = $first; $gi -lt $groups.Count; $gi++) {
    $g = @($groups[$gi])
    Write-Host ""
    Write-Host ("Job {0:HH:mm:ss} to {1:HH:mm:ss}: {2} steps" -f $g[0].Time, $g[-1].Time, $g.Count) -ForegroundColor Cyan
    $g | ForEach-Object {
        [pscustomobject]@{
            At = $_.Time.ToString('HH:mm:ss'); Step = $_.Step; Model_s = $_.Model; Text_only = if ($_.TextOnly) { 'yes' } else { '' }
            Controls = $_.Controls; Settle_s = $_.Settle; Voice_s = $_.Voice; You = $_.Outcome
            Picked = if ($_.Picked.Length -gt 60) { $_.Picked.Substring(0, 60) + '...' } else { $_.Picked }
        }
    } | Format-Table -AutoSize

    $n = $g.Count
    $avg = { param($v) $x = @($v | Where-Object { $null -ne $_ }); if ($x.Count) { [math]::Round(($x | Measure-Object -Average).Average, 2) } else { $null } }
    $show = { param($v) if ($null -eq $v) { 'n/a' } else { $v } }
    $withPic = $g | Where-Object { -not $_.TextOnly }
    $textOnly = $g | Where-Object { $_.TextOnly }
    Write-Host "Summary"
    Write-Host ("  model time per step    : {0} s   (with picture {1} s, text only {2} s)" -f (& $show (& $avg $g.Model)), (& $show (& $avg $withPic.Model)), (& $show (& $avg $textOnly.Model)))
    Write-Host ("  settle after a click   : {0} s" -f (& $show (& $avg $g.Settle)))
    Write-Host ("  voice after the answer : {0} s" -f (& $show (& $avg $g.Voice)))
    $settle = & $avg $g.Settle; if ($null -eq $settle) { $settle = 1.0 }
    $per = (& $avg $g.Model) + $settle + 0.6
    Write-Host ("  click to next hint     : about {0} s  (settle + ~0.6 s reading the screen + model)" -f [math]::Round($per, 1))
    Write-Host ("  you followed the pick  : {0} of {1}" -f @($g | Where-Object Outcome -eq 'followed').Count, $n)
    Write-Host ("  you clicked elsewhere  : {0}" -f @($g | Where-Object Outcome -eq 'elsewhere').Count)
    Write-Host ("  nothing resolved       : {0}   (a click/type step with no target)" -f @($g | Where-Object { $_.Step -in 'click', 'type' -and $_.Picked -like 'nothing*' }).Count)
    Write-Host ("  thin screens (<=12 controls): {0}   (probably read the wrong window or an unready page)" -f @($g | Where-Object Controls -le 12).Count)
    $says = $g | Group-Object Picked | Where-Object { $_.Count -ge 3 -and $_.Name -notlike 'nothing*' }
    foreach ($s in $says) { Write-Host ("  repeated pick x{0}     : {1}" -f $s.Count, $s.Name) -ForegroundColor Yellow }
}
