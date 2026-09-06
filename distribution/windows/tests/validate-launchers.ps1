<#
.SYNOPSIS
  Validates the Windows portable launcher scripts for correctness.

.DESCRIPTION
  Tests that can run standalone (no Pester required). Validates:
  - PowerShell script syntax
  - CMD script syntax
  - Portable layout expectations
  - Path resolution logic (no hardcoded drive letters)
  - Security invariants (no plaintext keys, no execution policy bypass)
#>

$ErrorActionPreference = 'Stop'
$script:scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$script:distDir   = Split-Path -Parent $script:scriptDir
$script:repoRoot  = ((Resolve-Path -LiteralPath (Join-Path $script:scriptDir '..\..\..')).Path)

$script:passed = 0
$script:failed = 0

function Assert-Test {
  param([string]$Name, [scriptblock]$Test)
  try {
    & $Test
    Write-Host "  PASS: $Name" -ForegroundColor Green
    $script:passed++
  } catch {
    Write-Host "  FAIL: $Name" -ForegroundColor Red
    Write-Host "        $($_.Exception.Message)" -ForegroundColor Yellow
    $script:failed++
  }
}

$d = $script:distDir
$r = $script:repoRoot

# --- Syntax validation ---

Assert-Test 'matrix.ps1 has valid PowerShell syntax' {
  $errors = $null
  $null = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $d 'matrix.ps1'), [ref]$null, [ref]$errors)
  if ($errors.Count -gt 0) { throw ($errors | ForEach-Object { $_.Message } | Out-String) }
}

Assert-Test 'matrix-personal.ps1 has valid PowerShell syntax' {
  $errors = $null
  $null = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $d 'matrix-personal.ps1'), [ref]$null, [ref]$errors)
  if ($errors.Count -gt 0) { throw ($errors | ForEach-Object { $_.Message } | Out-String) }
}

Assert-Test 'matrix-omniroute-health.ps1 has valid PowerShell syntax' {
  $errors = $null
  $null = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $d 'matrix-omniroute-health.ps1'), [ref]$null, [ref]$errors)
  if ($errors.Count -gt 0) { throw ($errors | ForEach-Object { $_.Message } | Out-String) }
}

Assert-Test 'install.ps1 has valid PowerShell syntax' {
  $errors = $null
  $null = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $d 'install.ps1'), [ref]$null, [ref]$errors)
  if ($errors.Count -gt 0) { throw ($errors | ForEach-Object { $_.Message } | Out-String) }
}

# --- Layout expectations ---

Assert-Test 'distribution directory contains all expected launcher files' {
  $expected = @('matrix.cmd', 'matrix.ps1', 'matrix-personal.ps1', 'matrix-installed.cmd', 'matrix-omniroute-health.ps1', 'install.ps1')
  foreach ($f in $expected) {
    if (-not (Test-Path -LiteralPath (Join-Path $d $f))) { throw "Missing: $f" }
  }
}

Assert-Test 'templates directory exists with omniroute config' {
  if (-not (Test-Path -LiteralPath (Join-Path $d 'templates\opencode.omniroute.jsonc'))) {
    throw "Missing template"
  }
}

# --- No hardcoded drive letters ---

foreach ($f in @('matrix.ps1', 'matrix.cmd', 'matrix-personal.ps1', 'matrix-installed.cmd')) {
  Assert-Test "$f contains no hardcoded drive letters" {
    $content = Get-Content -LiteralPath (Join-Path $d $f) -Raw
    if ($content -match '[A-Z]:\\') {
      throw "Hardcoded drive letter found"
    }
  }
}

# --- No plaintext secrets ---

Assert-Test 'no plaintext API keys in launcher scripts' {
  $patterns = @('sk-', 'ghp_', 'AKIA', 'Authorization: Bearer', 'xoxb-', 'password=')
  $files = @('matrix.ps1', 'matrix.cmd', 'matrix-personal.ps1', 'matrix-installed.cmd')
  foreach ($f in $files) {
    $content = Get-Content -LiteralPath (Join-Path $d $f) -Raw -ErrorAction SilentlyContinue
    if (-not $content) { continue }
    foreach ($pat in $patterns) {
      if ($content -match [regex]::Escape($pat)) { throw "Secret pattern '$pat' in $f" }
    }
  }
}

# --- No execution policy bypass ---

Assert-Test 'no launcher weakens execution policy or uses policy flags' {
  foreach ($f in @('matrix.ps1', 'matrix.cmd', 'matrix-personal.ps1', 'matrix-installed.cmd', 'install.ps1')) {
    $content = Get-Content -LiteralPath (Join-Path $d $f) -Raw -ErrorAction SilentlyContinue
    if (-not $content) { continue }
    if ($content -match 'Set-ExecutionPolicy|-ExecutionPolicy|\bBypass\b|Unrestricted') {
      throw "$f attempts to weaken execution policy"
    }
  }
}

# --- OmniRoute support paths ---

foreach ($f in @('matrix.ps1')) {
  Assert-Test "$f references bundled Node OmniRoute paths" {
    $content = Get-Content -LiteralPath (Join-Path $d $f) -Raw
    foreach ($r in @('omniroute\node.exe', 'omniroute\app\bin\omniroute.mjs', 'omniroute\omniroute.exe')) {
      if ($content -notmatch [regex]::Escape($r)) { throw "Missing: $r" }
    }
  }
}

# --- matrix.cmd delegation ---

Assert-Test 'matrix.cmd launches matrix.ps1 invisibly, without execution-policy flags' {
  $content = Get-Content -LiteralPath (Join-Path $d 'matrix.cmd') -Raw
  if ($content -notmatch 'matrix\.ps1') { throw "matrix.cmd does not reference matrix.ps1" }
  if ($content -notmatch 'powershell\.exe.*-File') { throw "matrix.cmd does not invoke PowerShell" }
  if ($content -notmatch '-WindowStyle Hidden') { throw "matrix.cmd does not hide the PowerShell window" }
  if ($content -match 'ExecutionPolicy') { throw "matrix.cmd uses execution-policy flags" }
}

# --- Launcher window behaviour (single visible window: the Matrix Code TUI) ---

Assert-Test 'matrix.ps1 starts the TUI with Start-Process so the launcher itself stays hidden' {
  $content = Get-Content -LiteralPath (Join-Path $d 'matrix.ps1') -Raw
  if ($content -notmatch 'Start-Process -FilePath \$matrixExe') { throw "TUI is not started via Start-Process" }
  if ($content -notmatch '\$tuiWindow') { throw "No TUI window-style selection" }
  if ($content -notmatch 'MATRIX_TUI_WINDOW') { throw "No MATRIX_TUI_WINDOW override" }
  if ($content -notmatch 'IsOutputRedirected') { throw "No redirected-output detection for the TUI window" }
  if ($content -notmatch "'Normal'") { throw "TUI does not default to a Normal visible window" }
}

# --- Health check uses 127.0.0.1 ---

Assert-Test 'launchers use 127.0.0.1 not localhost for health checks' {
  foreach ($f in @('matrix.ps1', 'matrix.cmd', 'matrix-installed.cmd')) {
    $content = Get-Content -LiteralPath (Join-Path $d $f) -Raw -ErrorAction SilentlyContinue
    if ($content -and $content -match 'http://localhost:20128') {
      throw "$f uses localhost instead of 127.0.0.1"
    }
    if ($content -and $content -match 'http://localhost:20260') {
      throw "$f uses localhost instead of 127.0.0.1"
    }
  }
}

# --- PID tracking ---

Assert-Test 'matrix.ps1 tracks OmniRoute PID for targeted cleanup' {
  $content = Get-Content -LiteralPath (Join-Path $d 'matrix.ps1') -Raw
  if ($content -notmatch 'omniroute\.pid') { throw "No PID file tracking" }
  if ($content -notmatch '\.Kill\(\)') { throw "No process-level Kill" }
}

# --- Matrix API orchestration ---

Assert-Test 'matrix.ps1 references Matrix API env surface and port 20260' {
  $content = Get-Content -LiteralPath (Join-Path $d 'matrix.ps1') -Raw
  foreach ($r in @('20260', 'MATRIX_API_KEY', 'MATRIX_API_ENABLED', 'MATRIX_API_PORT', 'matrix-api.pid')) {
    if ($content -notmatch [regex]::Escape($r)) { throw "Missing: $r" }
  }
}

Assert-Test 'matrix.ps1 starts the Matrix API via the headless matrix-api subcommand' {
  $content = Get-Content -LiteralPath (Join-Path $d 'matrix.ps1') -Raw
  if ($content -notmatch '\$startInfo\.Arguments = ''matrix-api''') {
    throw "No headless matrix-api spawn"
  }
}

Assert-Test 'matrix.ps1 fails closed only when the API is explicitly disabled' {
  $content = Get-Content -LiteralPath (Join-Path $d 'matrix.ps1') -Raw
  if ($content -notmatch 'MATRIX_API_ENABLED=false') { throw "No explicit-disable handling" }
  if ($content -notmatch 'fail closed') { throw "No fail-closed message" }
}

Assert-Test 'matrix.ps1 persists and restores the Matrix API key once, never printing it' {
  $content = Get-Content -LiteralPath (Join-Path $d 'matrix.ps1') -Raw
  foreach ($r in @('matrix-api.cred', 'ConvertFrom-SecureString', 'ConvertTo-SecureString', 'New-MatrixApiKey')) {
    if ($content -notmatch [regex]::Escape($r)) { throw "Missing: $r" }
  }
  if ($content -match 'Write-Host[^\r\n]*\$matrixApiKey') { throw "Key printed via Write-Host" }
  if ($content -match 'Set-Content[^\r\n]*\$matrixApiKey') { throw "Key persisted to disk in plaintext" }
}

Assert-Test 'matrix.ps1 never prints or persists the Matrix API key value' {
  $content = Get-Content -LiteralPath (Join-Path $d 'matrix.ps1') -Raw
  if ($content -match 'Write-Host[^\r\n]*\$matrixApiKey') { throw "Key printed via Write-Host" }
  if ($content -match 'Set-Content[^\r\n]*\$matrixApiKey') { throw "Key persisted to disk" }
}

Assert-Test 'matrix.ps1 passes the API key only via environment, never the command line' {
  $content = Get-Content -LiteralPath (Join-Path $d 'matrix.ps1') -Raw
  if ($content -match '\$startInfo\.Arguments =.*MATRIX_API_KEY') {
    throw "Key interpolated into the child command line"
  }
}

Assert-Test 'matrix.ps1 tracks the Matrix API PID for targeted cleanup' {
  $content = Get-Content -LiteralPath (Join-Path $d 'matrix.ps1') -Raw
  if ($content -notmatch 'matrix-api\.pid') { throw "No Matrix API PID file tracking" }
  if ($content -notmatch '\$matrixApiStarted -and \$matrixApiPid') {
    throw "Cleanup is not guarded by started-by-this-launcher"
  }
}

# --- OpenRouter upstream credential ---

Assert-Test 'matrix.ps1 resolves the OpenRouter key (env or DPAPI store)' {
  $content = Get-Content -LiteralPath (Join-Path $d 'matrix.ps1') -Raw
  if ($content -notmatch 'function Resolve-OpenRouterKey') { throw "No Resolve-OpenRouterKey function" }
  if ($content -notmatch '\$env:OPENROUTER_API_KEY = \$openrouter\.Key') { throw "OpenRouter key is not armed via environment" }
  if ($content -notmatch 'openrouter-api\.cred') { throw "No OpenRouter DPAPI store" }
}

Assert-Test 'matrix.ps1 never passes the OpenRouter key on a command line or to the console' {
  $content = Get-Content -LiteralPath (Join-Path $d 'matrix.ps1') -Raw
  if ($content -match '\$startInfo\.Arguments =.*OPENROUTER_API_KEY') {
    throw "OpenRouter key interpolated into the child command line"
  }
  if ($content -match 'Write-Host[^\r\n]*\$openrouter') { throw "OpenRouter key printed via Write-Host" }
  if ($content -match 'Set-Content[^\r\n]*\$openrouter') { throw "OpenRouter key persisted to disk in plaintext" }
}

Assert-Test 'matrix.ps1 only prompts for onboarding on a visible interactive console' {
  $content = Get-Content -LiteralPath (Join-Path $d 'matrix.ps1') -Raw
  if ($content -notmatch 'IsInputRedirected') { throw "No redirected-input check" }
  if ($content -notmatch 'IsWindowVisible') { throw "No visible-console check" }
  if ($content -notmatch 'Test-InteractiveConsole') { throw "No interactive-console gate" }
}

Assert-Test 'the .matrix/state credential store stays out of Git and the release build' {
  $rootIgnore = Get-Content -LiteralPath (Join-Path $r '.gitignore') -Raw
  if ($rootIgnore -notmatch '\.matrix') { throw "Repo .gitignore does not exclude .matrix/" }
  $tracked = & git -C $r ls-files
  if ($tracked -match '\.matrix') { throw ".matrix paths are tracked in Git" }
  $build = Get-Content -LiteralPath (Join-Path $r 'script\build-windows-distribution.ps1') -Raw
  if ($build -match '\.matrix') { throw "Build script references .matrix (could package creds)" }
}

# --- Env vars ---

Assert-Test 'matrix.ps1 sets all required environment variables' {
  $content = Get-Content -LiteralPath (Join-Path $d 'matrix.ps1') -Raw
  foreach ($v in @('XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'OPENCODE_CONFIG_DIR', 'MATRIX_VOICE_HELPER', 'MATRIX_VOICE_MODEL_DIR', 'MATRIX_PORTABLE_ROOT')) {
    if ($content -notmatch $v) { throw "Missing env var: $v" }
  }
}

# --- Path resolution ---

Assert-Test 'matrix.ps1 resolves root from script location' {
  $content = Get-Content -LiteralPath (Join-Path $d 'matrix.ps1') -Raw
  if (-not ($content -match '\$PSScriptRoot' -or $content -match 'MyInvocation')) {
    throw "No script-location-based root resolution"
  }
}

# --- Build script integration ---

Assert-Test 'build script copies matrix.ps1 to portable distribution' {
  $content = Get-Content -LiteralPath (Join-Path $r 'script\build-windows-distribution.ps1') -Raw
  if ($content -notmatch 'matrix\.ps1') { throw "Build script missing matrix.ps1 reference" }
}

Assert-Test 'build script runs PowerShell launcher smoke test' {
  $content = Get-Content -LiteralPath (Join-Path $r 'script\build-windows-distribution.ps1') -Raw
  if ($content -notmatch 'matrix\.ps1.*--version') { throw "Build script missing PS1 smoke test" }
}

# --- Results ---

Write-Host "`nResults: $($script:passed) passed, $($script:failed) failed, $($script:passed + $script:failed) total" -ForegroundColor $(if ($script:failed -eq 0) { 'Green' } else { 'Red' })
if ($script:failed -gt 0) { exit 1 }
exit 0
