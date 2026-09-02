$ErrorActionPreference = "Stop"

$source = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$destination = Join-Path $env:LOCALAPPDATA "Matrix Code"
if ($source -eq $destination) {
  Write-Host "Matrix Code is already running from its install directory."
  exit 0
}

New-Item -ItemType Directory -Force -Path $destination | Out-Null
Get-ChildItem -LiteralPath $source | Where-Object { $_.Name -ne "install.ps1" } | Copy-Item -Destination $destination -Recurse -Force

# Route `matrix` through the OmniRoute auto-start launcher so the installed path
# behaves like the Portable distribution (health-check -> start -> readiness).
# The launcher lives in a bin\ dir that contains no matrix.exe, so `matrix` on
# PATH resolves to matrix.cmd (auto-start) instead of running matrix.exe directly.
$binDir = Join-Path $destination "bin"
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
Copy-Item -LiteralPath (Join-Path $destination "matrix-installed.cmd") -Destination (Join-Path $binDir "matrix.cmd") -Force

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$entries = @($userPath -split ";" | Where-Object { $_ })
# Replace the old install-dir entry (raw matrix.exe, no auto-start) with the launcher dir.
$entries = @($entries | Where-Object { $_ -ne $destination })
if ($entries -notcontains $binDir) {
  $entries = @($entries + $binDir)
}
[Environment]::SetEnvironmentVariable("Path", ($entries -join ";"), "User")

Write-Host "Matrix Code installed in $destination"
Write-Host "Open a new terminal and run: matrix"
