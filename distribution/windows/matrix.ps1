<#
.SYNOPSIS
  Matrix Code portable launcher for Windows (PowerShell-first).

.DESCRIPTION
  Portable launcher that resolves all paths relative to its own location.
  Works in restricted Windows environments where cmd.exe may be blocked by
  administrator policy. matrix.cmd launches this script invisibly, so the only
  window the user sees is the Matrix Code TUI, opened in its own window. It
  owns the lifecycle of two optional local services that run in the background:

  OmniRoute (port 20128):
    - <portable-root>\omniroute\omniroute.exe       (standalone binary)
    - <portable-root>\omniroute\node.exe            (bundled Node runtime)
    - <portable-root>\omniroute\app\bin\omniroute.mjs (Node entry point)

  Matrix API (port 20260):
    - started only when MATRIX_API_ENABLED=true AND a key is available
      (fail closed against explicit MATRIX_API_ENABLED=false)
    - runs as a headless child: <portable-root>\matrix.exe matrix-api
    - MATRIX_API_PORT overrides 20260

  The Matrix API key is resolved once and reused forever so the API always
  comes back online on the next launch even after the original PowerShell
  session that seeded it is gone:

    1. MATRIX_API_KEY in the environment wins for this run; it is persisted
       to the credential store when the store has no entry yet.
    2. Otherwise the per-user DPAPI-protected store is read:
       <portable-root>\.matrix\state\matrix-api.cred
    3. Otherwise a strong random key is generated and persisted to the store.

  The credential store is encrypted with the current Windows user's DPAPI
  scope, ACL-restricted to that user, never printed, never written to the
  command line, never logged, and never committed.

  For both services the launcher reuses an already-active listener, starts one
  only if nothing is listening, recovers stale PID tracking, polls for
  readiness, and on close kills only the processes it started itself. A stale
  .matrix\*.pid can never block a restart, and processes the launcher did not
  start are never killed.

.NOTES
  matrix.cmd delegates here and runs this script with a hidden window; the
  Matrix Code TUI is then started visibly as the single user-facing window.
  Does not use execution-policy flags, never weakens machine security controls,
  requires no admin privileges, no npm install, no global Node dependency.
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

# First run deploys the bundled OmniRoute config so the TUI ships with a
# working `omniroute` provider (and the Matrix router candidates) instead of an
# empty config dir. Existing user config is left untouched.
$configFile = Join-Path $env:OPENCODE_CONFIG_DIR 'opencode.jsonc'
$templateConfig = Join-Path $root 'templates\opencode.omniroute.jsonc'
if ((-not (Test-Path -LiteralPath $configFile)) -and (Test-Path -LiteralPath $templateConfig)) {
  Copy-Item -LiteralPath $templateConfig -Destination $configFile
}

# OmniRoute is owned by this launcher on 20128; default the config template's
# {env:OMNIROUTE_BASE_URL} to that endpoint unless the caller provided one.
if (-not $env:OMNIROUTE_BASE_URL) {
  $env:OMNIROUTE_BASE_URL = 'http://127.0.0.1:20128/v1'
}

$matrixExe = Join-Path $root 'matrix.exe'
if (-not (Test-Path -LiteralPath $matrixExe)) {
  Write-Host "Error: matrix.exe not found at $matrixExe"
  exit 1
}

# --- helpers ----------------------------------------------------------------

# True when a listener answers on the given endpoint. Any HTTP response (2xx,
# 401, 5xx, ...) proves a process owns the port, so callers reuse it and never
# spawn a duplicate. A refused connection is the only "not active" signal.
function Test-LocalService {
  param(
    [string]$Uri,
    [hashtable]$Headers = @{}
  )
  try {
    $response = Invoke-WebRequest -Uri $Uri -Method Get -TimeoutSec 2 -UseBasicParsing -Headers $Headers -ErrorAction Stop
    return ($response.StatusCode -eq 200)
  } catch {
    if ($_.Exception.Response -and $_.Exception.Response.StatusCode -eq 401) { return $true }
    return $false
  }
}

# Read a positive non-zero PID from a PID file, or $null when absent/invalid.
function Get-TrackedPid {
  param([string]$PidFile)
  if (-not (Test-Path -LiteralPath $PidFile)) { return $null }
  try {
    $raw = (Get-Content -LiteralPath $PidFile -Raw -ErrorAction Stop).Trim()
    if (-not $raw) { return $null }
    $parsed = 0
    if ([int]::TryParse($raw, [ref]$parsed) -and $parsed -gt 0) { return $parsed }
  } catch { }
  return $null
}

function Test-ProcessAlive {
  param([int]$ProcessId)
  return ($null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue))
}

function Get-ProcessCommandLine {
  param([int]$ProcessId)
  try {
    return (Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop).CommandLine
  } catch {
    return $null
  }
}

# Poll a local endpoint until it answers, the tracked process exits, or the
# deadline passes. Returns $true only on a confirmed listener.
function Wait-LocalService {
  param(
    [string]$Uri,
    [hashtable]$Headers = @{},
    [System.Diagnostics.Process]$TrackedProcess = $null,
    [int]$TimeoutSeconds = 15,
    [string]$ServiceName = 'service'
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    if (Test-LocalService -Uri $Uri -Headers $Headers) { return $true }
    if ($TrackedProcess) {
      try {
        if ($TrackedProcess.HasExited) { return $false }
      } catch {
        return $false
      }
    }
  }
  return $false
}

# Start a service unless a live listener already covers the port, reusing the
# existing listener whenever possible. Stale PID tracking is recovered without
# ever killing a process whose command line does not look like the service.
# Returns the state needed by the caller to safely scope cleanup to itself.
function Start-ManagedService {
  param(
    [string]$Name,
    [string]$HealthUri,
    [hashtable]$Headers = @{},
    [string]$PidFile,
    [string]$CmdLineMarker,
    [int]$ReadinessTimeout = 15,
    [scriptblock]$Starter
  )

  $running = Test-LocalService -Uri $HealthUri -Headers $Headers
  $trackedPid = $null

  if (-not $running) {
    $trackedPid = Get-TrackedPid -PidFile $PidFile
    if ($trackedPid -and (Test-ProcessAlive -ProcessId $trackedPid)) {
      Write-Host "$Name already tracked (PID $trackedPid). Waiting for readiness..."
      $running = Wait-LocalService -Uri $HealthUri -Headers $Headers -TimeoutSeconds 5 -ServiceName $Name
    }
  }

  $process = $null
  $started = $false
  $pidValue = $null

  if ($running) {
    Write-Host "$Name already active at $HealthUri. Reusing it."
  } else {
    if ($trackedPid -and (Test-ProcessAlive -ProcessId $trackedPid)) {
      $cmdLine = Get-ProcessCommandLine -ProcessId $trackedPid
      if ($cmdLine -and $cmdLine -match [regex]::Escape($CmdLineMarker)) {
        Write-Host "Recovering stale $Name process (PID $trackedPid) that is no longer serving."
        Stop-Process -Id $trackedPid -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 500
      } else {
        Write-Host "Ignoring unrelated process (PID $trackedPid) left in the PID file; starting $Name fresh."
      }
    }
    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue

    Write-Host "Starting $Name..."
    $process = & $Starter
    if ($null -eq $process) { throw "Failed to start $Name" }
    $started = $true
    $pidValue = $process.Id
    New-Item -ItemType Directory -Force -Path (Split-Path $PidFile) | Out-Null
    Set-Content -LiteralPath $PidFile -Value $pidValue -Force
  }

  if ($started -or $running) {
    $ready = Wait-LocalService -Uri $HealthUri -Headers $Headers -TrackedProcess $process -TimeoutSeconds $ReadinessTimeout -ServiceName $Name
    if (-not $ready) {
      Write-Host "Warning: $Name did not become ready within timeout. Starting Matrix Code anyway."
    }
  }

  return [pscustomobject]@{
    Running = [bool]$running
    Started = $started
    Pid     = $pidValue
    Process = $process
    Ready   = $running
  }
}

# --- Matrix API credential store (secure, survives PowerShell sessions) -----
# The key is kept in a DPAPI-protected file scoped to the current Windows user
# so the API can be brought back online on every launch even after the shell
# that originally configured it is closed. Nothing is ever echoed or logged.

$matrixCredFile = Join-Path $root '.matrix\state\matrix-api.cred'

function New-MatrixApiKey {
  $bytes = New-Object byte[] 32
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($bytes)
  $rng.Dispose()
  return [Convert]::ToBase64String($bytes)
}

# Best effort: make an on-disk secret readable only by the current user.
function Restrict-FileAccess {
  param([string]$Path)
  try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity.Name, 'FullControl', 'Allow')
    $acl = Get-Acl -LiteralPath $Path
    $acl.SetAccessRuleProtection($true, $false)
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $Path -AclObject $acl
  } catch { }
}

function Write-MatrixApiKeyToStore {
  param(
    [string]$Path,
    [string]$Key
  )
  New-Item -ItemType Directory -Force -Path (Split-Path $Path) | Out-Null
  $secure = ConvertTo-SecureString -String $Key -AsPlainText -Force
  $encrypted = ConvertFrom-SecureString -SecureString $secure
  Set-Content -LiteralPath $Path -Value $encrypted -Force
  $secure = $null
  Restrict-FileAccess -Path $Path
}

function Read-MatrixApiKeyFromStore {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  try {
    $encrypted = (Get-Content -LiteralPath $Path -Raw -ErrorAction Stop).Trim()
    if (-not $encrypted) { return $null }
    $secure = ConvertTo-SecureString -String $encrypted -ErrorAction Stop
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
      return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    } finally {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
  } catch {
    return $null
  }
}

# --- OpenRouter credential (free direct upstream) -----------------------------

function Test-InteractiveConsole {
  # A prompt is only ever shown on a real, visible, interactive console;
  # hidden-window (matrix.cmd) and automated launches skip it and stay
  # fail-closed. The type check keeps Add-Type idempotent across re-dot-sources.
  if ($Host.Name -ne 'ConsoleHost') { return $false }
  if ([Console]::IsInputRedirected -or [Console]::IsOutputRedirected) { return $false }
  try {
    if (-not ('MatrixConsoleNative' -as [type])) {
      Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MatrixConsoleNative {
  [DllImport("kernel32.dll")]
  public static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hwnd);
}
'@ -ErrorAction Stop
    }
    $consoleHandle = [MatrixConsoleNative]::GetConsoleWindow()
    if ([IntPtr]::Zero -eq $consoleHandle) { return $false }
    return [MatrixConsoleNative]::IsWindowVisible($consoleHandle)
  } catch {
    return $false
  }
}

# Resolution order for the Matrix API's free upstream credential: a live
# OPENROUTER_API_KEY wins for this run; otherwise the DPAPI store at
# .matrix\state\openrouter-api.cred is restored; otherwise a one-time
# interactive onboarding persists it the same way. Returns $null (fail-closed)
# when no usable key exists, so the pool stays empty exactly as before and the
# launcher never prompts invisibly. The key never reaches a command line.
function Resolve-OpenRouterKey {
  param(
    [string]$CredFile,
    [string]$EnvKey = $env:OPENROUTER_API_KEY,
    [switch]$AllowOnboarding
  )

  if (-not [string]::IsNullOrWhiteSpace($EnvKey)) {
    return [pscustomobject]@{ Key = $EnvKey.Trim(); Source = 'env' }
  }

  if (Test-Path -LiteralPath $CredFile) {
    $storedKey = Read-MatrixApiKeyFromStore -Path $CredFile
    if ($storedKey) {
      return [pscustomobject]@{ Key = $storedKey; Source = 'store' }
    }
  }

  if (-not $AllowOnboarding) { return $null }
  if (-not (Test-InteractiveConsole)) { return $null }

  try {
    $onboardedKey = Read-Host -Prompt 'No OpenRouter key is configured. Paste your OpenRouter API key (stored once via DPAPI):'
  } catch {
    return $null
  }
  $onboardedKey = $onboardedKey.Trim()
  if (-not $onboardedKey) { return $null }

  try {
    Write-MatrixApiKeyToStore -Path $CredFile -Key $onboardedKey
  } catch {
    return $null
  }
  Write-Host 'OpenRouter key stored in .matrix\state\openrouter-api.cred; it will be restored on future launches.'
  return [pscustomobject]@{ Key = $onboardedKey; Source = 'onboard' }
}

# --- Matrix API environment --------------------------------------------------

$matrixApiPort = 20260
if ($env:MATRIX_API_PORT) {
  $parsedPort = 0
  if ([int]::TryParse($env:MATRIX_API_PORT, [ref]$parsedPort)) {
    if ($parsedPort -ge 1 -and $parsedPort -le 65535) { $matrixApiPort = $parsedPort }
  }
}
$env:MATRIX_API_PORT = [string]$matrixApiPort

# Respect an explicit opt-out; otherwise resolve, persist and arm the key once.
$explicitApiDisable = $false
$_enabledRaw = $env:MATRIX_API_ENABLED
if ($_enabledRaw -and $_enabledRaw.Trim()) {
  $_enabledNorm = $_enabledRaw.Trim().ToLowerInvariant()
  if ($_enabledNorm -eq 'false' -or $_enabledNorm -eq '0') { $explicitApiDisable = $true }
}
Remove-Variable _enabledRaw -ErrorAction SilentlyContinue
Remove-Variable _enabledNorm -ErrorAction SilentlyContinue

$matrixApiKey = $null
if ($explicitApiDisable) {
  Write-Host 'Matrix API is explicitly disabled (MATRIX_API_ENABLED=false); the local API fails closed and is not managed.'
} else {
  $_envKey = $env:MATRIX_API_KEY
  if ($_envKey) { $_envKey = $_envKey.Trim() }

  if ($_envKey) {
    $matrixApiKey = $_envKey
    if (-not (Test-Path -LiteralPath $matrixCredFile)) {
      Write-MatrixApiKeyToStore -Path $matrixCredFile -Key $matrixApiKey
    }
  } else {
    $matrixApiKey = Read-MatrixApiKeyFromStore -Path $matrixCredFile
    if (-not $matrixApiKey) {
      $matrixApiKey = New-MatrixApiKey
      Write-MatrixApiKeyToStore -Path $matrixCredFile -Key $matrixApiKey
      Write-Host 'No Matrix API key was configured. Generated and stored one in .matrix\state\matrix-api.cred; it will be reused automatically.'
    } else {
      Write-Host 'Matrix API key restored from .matrix\state\matrix-api.cred.'
    }
  }
  Remove-Variable _envKey -ErrorAction SilentlyContinue

  # Arm the API for every child the launcher starts today (OmniRoute, headless
  # matrix-api, and the TUI itself) without ever passing the key on a command
  # line. The environment only ever lives inside this process and its children.
  $env:MATRIX_API_ENABLED = 'true'
  $env:MATRIX_API_KEY = $matrixApiKey
}

# --- OpenRouter credential for the Matrix API free upstream -------------------
# The matrix-api child activates its cost-0 provider pool from the
# OPENROUTER_API_KEY environment. Env wins; otherwise the DPAPI store at
# .matrix\state\openrouter-api.cred is restored; otherwise a plain desktop
# launch may onboard interactively once. Onboarding is refused from the
# hidden-window/automated paths, and a missing key leaves the pool fail-closed
# (UNAVAILABLE) exactly as before. The key is armed only via environment and
# never reaches a command line.
$openrouterCredFile = Join-Path $root '.matrix\state\openrouter-api.cred'
$openrouterOnboard  = ($args.Count -eq 0)
$openrouter = Resolve-OpenRouterKey -CredFile $openrouterCredFile -AllowOnboarding:$openrouterOnboard
if ($openrouter) {
  $env:OPENROUTER_API_KEY = $openrouter.Key
} elseif ($openrouterOnboard) {
  Write-Host 'OpenRouter key not configured; the Matrix API free direct upstream stays disabled. Set OPENROUTER_API_KEY in the environment (or run matrix.ps1 from a terminal to onboard once) and relaunch.'
}

$matrixApiHealth = "http://127.0.0.1:$matrixApiPort/v1/models"
$matrixApiHeaders = @{}
if ($matrixApiKey) { $matrixApiHeaders['Authorization'] = "Bearer $matrixApiKey" }

# --- lifecycle state --------------------------------------------------------

$readinessTimeout = 15

$omniRoutePidFile = Join-Path $root '.matrix\omniroute.pid'
$omniRouteHealth  = 'http://127.0.0.1:20128/v1/models'
$omniRouteStarted = $false
$omniRouteProcess = $null

$matrixApiPidFile  = Join-Path $root '.matrix\matrix-api.pid'
$matrixApiStarted  = $false
$matrixApiProcess  = $null
$matrixApiPid      = $null

$matrixExit = 0

try {
  # --- OmniRoute (port 20128) ------------------------------------------------
  # A live listener on 20128 is always reused (never started, never killed).
  # Otherwise a launch axis is resolved: vendored standalone exe, vendored Node
  # runtime, or a normal/global omniroute installation. With none of those and
  # no active listener, Matrix runs on fallback without OmniRoute.
  $nodeExe   = Join-Path $root 'omniroute\node.exe'
  $entryMjs  = Join-Path $root 'omniroute\app\bin\omniroute.mjs'
  $omniExe   = Join-Path $root 'omniroute\omniroute.exe'
  $canStartNode = (Test-Path -LiteralPath $nodeExe) -and (Test-Path -LiteralPath $entryMjs)
  $canStartExe  = Test-Path -LiteralPath $omniExe
  $globalOmni = $null
  if ((-not $canStartNode) -and (-not $canStartExe)) {
    $globalOmni = Get-Command omniroute -ErrorAction SilentlyContinue
  }

  if ($canStartNode -or $canStartExe -or $globalOmni) {
    $omniRoute = Start-ManagedService `
      -Name 'OmniRoute' `
      -HealthUri $omniRouteHealth `
      -PidFile $omniRoutePidFile `
      -CmdLineMarker 'omniroute' `
      -ReadinessTimeout $readinessTimeout `
      -Starter {
      $startInfo = New-Object System.Diagnostics.ProcessStartInfo
      if ($canStartExe) {
        $startInfo.FileName = $omniExe
        $startInfo.WorkingDirectory = Join-Path $root 'omniroute'
      } elseif ($globalOmni) {
        $startInfo.FileName = $globalOmni.Source
        $startInfo.WorkingDirectory = Split-Path -Parent $globalOmni.Source
      } else {
        $startInfo.FileName = $nodeExe
        $startInfo.Arguments = $entryMjs
        $startInfo.WorkingDirectory = Join-Path $root 'omniroute'
      }
      $startInfo.UseShellExecute       = $false
      $startInfo.CreateNoWindow         = $true
      $startInfo.RedirectStandardOutput = $true
      $startInfo.RedirectStandardError  = $true
      [System.Diagnostics.Process]::Start($startInfo)
    }
    $omniRouteStarted = $omniRoute.Started
    $omniRouteProcess = $omniRoute.Process
  } else {
    Write-Host 'OmniRoute is not available locally. Starting Matrix Code without OmniRoute.'
    Write-Host '  OmniRoute routes may report "Cannot connect to API" until a provider is configured.'
  }

  # --- Matrix API (port 20260) ----------------------------------------------
  # Keyed like the core API contract. A live listener is reused; otherwise the
  # headless child is started and tracked by PID so cleanup never touches a
  # process this launcher did not create.
  if ($matrixApiKey) {
    $matrixApi = Start-ManagedService `
      -Name 'Matrix API' `
      -HealthUri $matrixApiHealth `
      -Headers $matrixApiHeaders `
      -PidFile $matrixApiPidFile `
      -CmdLineMarker 'matrix-api' `
      -ReadinessTimeout $readinessTimeout `
      -Starter {
      $startInfo = New-Object System.Diagnostics.ProcessStartInfo
      $startInfo.FileName = $matrixExe
      $startInfo.Arguments = 'matrix-api'
      $startInfo.UseShellExecute       = $false
      $startInfo.CreateNoWindow         = $true
      $startInfo.RedirectStandardOutput = $true
      $startInfo.RedirectStandardError  = $true
      $startInfo.WorkingDirectory       = $root
      [System.Diagnostics.Process]::Start($startInfo)
    }
    $matrixApiStarted = $matrixApi.Started
    $matrixApiProcess = $matrixApi.Process
    $matrixApiPid     = $matrixApi.Pid
  }

  # --- Matrix TUI -----------------------------------------------------------
  # This launcher runs invisibly, so the TUI is the only visible window.
  # Normal by default; Hidden when output is redirected (tests, build smoke) or
  # forced via MATRIX_TUI_WINDOW. Start-Process gives the console app its own
  # window instead of inheriting the hidden launcher console.
  $tuiWindow = $env:MATRIX_TUI_WINDOW
  if (-not $tuiWindow) {
    $tuiWindow = if ([Console]::IsOutputRedirected) { 'Hidden' } else { 'Normal' }
  }
  $tuiArgString = (@($args) | ForEach-Object {
    if ($_ -match '\s') { "`"$($_.Replace('"', '""'))`"" } else { $_ }
  }) -join ' '
  if ($tuiArgString) {
    $tuiProcess = Start-Process -FilePath $matrixExe -ArgumentList $tuiArgString -WindowStyle $tuiWindow -PassThru
  } else {
    $tuiProcess = Start-Process -FilePath $matrixExe -WindowStyle $tuiWindow -PassThru
  }
  $tuiProcess.WaitForExit()
  $matrixExit = $tuiProcess.ExitCode
  if ($null -eq $matrixExit) { $matrixExit = 0 }
}
finally {
  if ($omniRouteStarted -and $null -ne $omniRouteProcess) {
    try {
      if (-not $omniRouteProcess.HasExited) {
        Write-Host 'Stopping OmniRoute gateway...'
        $omniRouteProcess.Kill()
        $omniRouteProcess.WaitForExit(5000)
      }
    } catch { }
    Remove-Item -LiteralPath $omniRoutePidFile -Force -ErrorAction SilentlyContinue
  }

  if ($matrixApiStarted -and $matrixApiPid -and $null -ne $matrixApiProcess) {
    try {
      if (-not $matrixApiProcess.HasExited) {
        Write-Host 'Stopping Matrix API...'
        $matrixApiProcess.Kill()
        $matrixApiProcess.WaitForExit(5000)
      }
    } catch { }
    Remove-Item -LiteralPath $matrixApiPidFile -Force -ErrorAction SilentlyContinue
  }
}

exit $matrixExit