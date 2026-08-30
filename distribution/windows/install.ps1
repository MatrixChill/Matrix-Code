$ErrorActionPreference = "Stop"

$source = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$destination = Join-Path $env:LOCALAPPDATA "Matrix Code"
if ($source -eq $destination) {
  Write-Host "Matrix Code is already running from its install directory."
  exit 0
}

New-Item -ItemType Directory -Force -Path $destination | Out-Null
Get-ChildItem -LiteralPath $source | Where-Object { $_.Name -ne "install.ps1" } | Copy-Item -Destination $destination -Recurse -Force

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$entries = @($userPath -split ";" | Where-Object { $_ })
if ($entries -notcontains $destination) {
  [Environment]::SetEnvironmentVariable("Path", (($entries + $destination) -join ";"), "User")
}

Write-Host "Matrix Code installed in $destination"
Write-Host "Open a new terminal and run: matrix"
