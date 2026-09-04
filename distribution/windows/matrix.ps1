<#
.SYNOPSIS
  Matrix Code portable launcher for Windows (PowerShell-first).

.DESCRIPTION
  Portable launcher that resolves all paths relative to its own location.
  Works in restricted Windows environments where cmd.exe may be blocked by
  administrator policy. Supports optional bundled OmniRoute with a co-located
  Node.js runtime.

  OmniRoute support (all optional, no hard dependencies):
    - <portable-root>\omniroute\omniroute.exe   (standalone binary)
    - <portable-root>\omniroute\node.exe          (bundled Node runtime)
    - <portable-root>\omniroute\app\bin\omniroute.mjs (Node entry point)

  The launcher only starts OmniRoute if it is available and not already running.
  It only cleans up a process it started itself.

.NOTES
  Does not weaken execution policy or bypass machine security controls.
  No admin privileges, no npm install, no global Node dependency required.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
if (-not $root) {
  $root = Split-Path -Parent $MyInvocation.MyCommand.Definition
}
$root = (Resolve-Path -LiteralPath $root).Path

$env:MATRIX_PORTABLE_ROOT = $root
$env:XDG_CONFIG_HOME      = Join-Path $root '.matrix\config'
$env:XDG_DATA_HOME        = Join-Path $root '.matrix\data'
$env:XDG_CACHE_HOME       = Join-Path $root '.matrix\cache'
$env:XDG_STATE_HOME       = Join-Path $root '.matrix\state'
$env:OPENCODE_CONFIG_DIR  = Join-Path $env:XDG_CONFIG_HOME 'opencode'
$env:MATRIX_VOICE_HELPER  = Join-Path $root 'matrix-voice\matrix-voice-helper.exe'
$env:MATRIX_VOICE_MODEL_DIR = Join-Path $root 'matrix-voice\model'

foreach ($dir in @($env:OPENCODE_CONFIG_DIR, $env:XDG_DATA_HOME, $env:XDG_CACHE_HOME, $env:XDG_STATE_HOME)) {
  if (-not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
  }
}

$omniRouteStarted = $false
$omniRoutePid     = $null
$pidFile          = Join-Path $root '.matrix\omniroute.pid'
$healthUrl        = 'http://127.0.0.1:20128/v1/models'
$readinessTimeout = 15

try {
  $alreadyRunning = $false
  try {
    $resp = Invoke-WebRequest -Uri $healthUrl -Method Get -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
    if ($resp.StatusCode -eq 200) { $alreadyRunning = $true }
  } catch { }

  if (-not $alreadyRunning) {
    $nodeExe   = Join-Path $root 'omniroute\node.exe'
    $entryMjs  = Join-Path $root 'omniroute\app\bin\omniroute.mjs'
    $omniExe   = Join-Path $root 'omniroute\omniroute.exe'

    $canStartNode = (Test-Path -LiteralPath $nodeExe) -and (Test-Path -LiteralPath $entryMjs)
    $canStartExe  = Test-Path -LiteralPath $omniExe

    if ((-not $canStartNode) -and (-not $canStartExe)) {
      Write-Host 'OmniRoute is not available locally. Starting Matrix Code without OmniRoute.'
      Write-Host '  OmniRoute routes may report "Cannot connect to API" until a provider is configured.'
    }
    else {
      if (Test-Path -LiteralPath $pidFile) {
        try {
          $existingPid = [int](Get-Content -LiteralPath $pidFile -ErrorAction Stop)
          $existingProc = Get-Process -Id $existingPid -ErrorAction Stop
          Write-Host "OmniRoute already tracked (PID $existingPid). Waiting for readiness..."
          $alreadyRunning = $true
        } catch {
          Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
        }
      }

      if (-not $alreadyRunning) {
        Write-Host 'Starting OmniRoute gateway...'
        $startInfo = New-Object System.Diagnostics.ProcessStartInfo
        if ($canStartExe) {
          $startInfo.FileName = $omniExe
        } else {
          $startInfo.FileName = $nodeExe
          $startInfo.Arguments = $entryMjs
        }
        $startInfo.UseShellExecute        = $false
        $startInfo.CreateNoWindow          = $true
        $startInfo.RedirectStandardOutput  = $true
        $startInfo.RedirectStandardError   = $true
        $startInfo.WorkingDirectory        = Join-Path $root 'omniroute'

        $proc = [System.Diagnostics.Process]::Start($startInfo)
        $omniRoutePid = $proc.Id
        $omniRouteStarted = $true
        New-Item -ItemType Directory -Force -Path (Split-Path $pidFile) | Out-Null
        Set-Content -LiteralPath $pidFile -Value $omniRoutePid -Force
      }
    }

    if ($omniRouteStarted -or $alreadyRunning) {
      $deadline = (Get-Date).AddSeconds($readinessTimeout)
      $ready = $false
      while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 500
        try {
          $check = Invoke-WebRequest -Uri $healthUrl -Method Get -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
          if ($check.StatusCode -eq 200) { $ready = $true; break }
        } catch { }

        if ($omniRouteStarted -and $omniRoutePid) {
          $alive = Get-Process -Id $omniRoutePid -ErrorAction SilentlyContinue
          if (-not $alive) {
            Write-Host 'Warning: OmniRoute process exited unexpectedly.'
            break
          }
        }
      }

      if (-not $ready) {
        Write-Host 'Warning: OmniRoute did not become ready within timeout. Starting Matrix Code anyway.'
      }
    }
  }

  $matrixExe = Join-Path $root 'matrix.exe'
  if (-not (Test-Path -LiteralPath $matrixExe)) {
    Write-Host "Error: matrix.exe not found at $matrixExe"
    exit 1
  }

  & $matrixExe @args
  $matrixExit = $LASTEXITCODE
  if ($null -eq $matrixExit) { $matrixExit = 0 }
}
finally {
  if ($omniRouteStarted -and $omniRoutePid) {
    try {
      $proc = Get-Process -Id $omniRoutePid -ErrorAction Stop
      Write-Host 'Stopping OmniRoute gateway...'
      $proc.Kill()
      $proc.WaitForExit(5000)
    } catch { }
  }

  if (Test-Path -LiteralPath $pidFile) {
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  }
}

exit $matrixExit
