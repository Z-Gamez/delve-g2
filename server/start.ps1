# Starts the Delve server in the background (no console window).
# Python is taken from, in order: -Python, "python" in config.json, .venv here, pythonw on PATH.
param(
  [string]$Python = '',
  [string]$Log = "$PSScriptRoot\delve-server.log"
)
. "$PSScriptRoot\find-python.ps1"
$exe = Find-DelvePython $Python
Start-Process -FilePath $exe -ArgumentList @('delve_server.py', '--log-file', "`"$Log`"") -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
Write-Host "Delve server starting with $exe; log: $Log"
