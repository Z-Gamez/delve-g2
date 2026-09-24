# Shared by start.ps1 and install-autostart.ps1: which pythonw runs the server.
function Find-DelvePython([string]$Explicit) {
  if ($Explicit) { return $Explicit }
  $cfg = Join-Path $PSScriptRoot 'config.json'
  if (Test-Path $cfg) {
    $fromConfig = (Get-Content $cfg -Raw | ConvertFrom-Json).python
    if ($fromConfig) { return [Environment]::ExpandEnvironmentVariables($fromConfig) }
  }
  $venv = Join-Path $PSScriptRoot '.venv\Scripts\pythonw.exe'
  if (Test-Path $venv) { return $venv }
  $onPath = Get-Command pythonw.exe -ErrorAction SilentlyContinue
  if ($onPath) { return $onPath.Source }
  throw 'No Python found. Create server\.venv (see README) or pass -Python.'
}
