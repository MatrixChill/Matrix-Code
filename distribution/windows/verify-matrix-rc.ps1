param(
  [string]$Root = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path -LiteralPath $Root).Path
$matrixExe = Join-Path $Root 'matrix.exe'
$stateDir = Join-Path $Root '.matrix'
$configFile = Join-Path $Root '.matrix\config\opencode\opencode.jsonc'

Write-Output "Root=$Root"
Write-Output "Version=$((& $matrixExe --version) -join ' ')"
Write-Output "MatrixStateExists=$([bool](Test-Path -LiteralPath $stateDir))"
Write-Output "ConfigPath=$configFile"
Write-Output "ConfigExists=$([bool](Test-Path -LiteralPath $configFile))"

foreach ($port in @(20128, 20260)) {
  $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
  if (-not $listeners) {
    Write-Output "Listener$port=NONE"
    continue
  }

  foreach ($listener in $listeners) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
    Write-Output "Listener$port=PID:$($listener.OwningProcess) CommandLine:$($process.CommandLine)"
  }
}

if (Test-Path -LiteralPath $configFile) {
  $config = Get-Content -LiteralPath $configFile -Raw
  foreach ($alias in @(
    'Matrix Coding Free (Direct)',
    'Matrix Coding Reliable',
    'Matrix Free Auto',
    'Matrix Vision (Direct)'
  )) {
    Write-Output "Alias:$alias=$($config.Contains($alias))"
  }
}
