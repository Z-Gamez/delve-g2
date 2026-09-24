# Registers a "Delve Server" scheduled task that starts the server at logon.
# Remove it with: Unregister-ScheduledTask -TaskName 'Delve Server' -Confirm:$false
param([string]$Python = '')
. "$PSScriptRoot\find-python.ps1"
$exe = Find-DelvePython $Python
$log = Join-Path $PSScriptRoot 'delve-server.log'
$action = New-ScheduledTaskAction -Execute $exe -Argument "delve_server.py --log-file `"$log`"" -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit 0
Register-ScheduledTask -TaskName 'Delve Server' -Action $action -Trigger $trigger -Settings $settings -Description 'Speech + AI Dungeon Master for Delve on Even G2' -Force | Out-Null
Write-Host "Registered 'Delve Server' (starts at logon with $exe)."
