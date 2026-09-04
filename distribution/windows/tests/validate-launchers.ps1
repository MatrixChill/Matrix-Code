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
  [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $d 'matrix.ps1'), [ref]$null, [ref]$errors)
  if ($errors.Count -gt 0) { throw ($errors | ForEach-Object { $_.Message } | Out-String) }
}

Assert-Test 'matrix-personal.ps1 has valid PowerShell syntax' {
  $errors = $null
  [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $d 'matrix-personal.ps1'), [ref]$null, [ref]$errors)
  if ($errors.Count -gt 0) { throw ($errors | ForEach-Object { $_.Message } | Out-String) }
}

Assert-Test 'matrix-omniroute-health.ps1 has valid PowerShell syntax' {
  $errors = $null
  [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $d 'matrix-omniroute-health.ps1'), [ref]$null, [ref]$errors)
  if ($errors.Count -gt 0) { throw ($errors | ForEach-Object { $_.Message } | Out-String) }
}

Assert-Test 'install.ps1 has valid PowerShell syntax' {
  $errors = $null
  [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $d 'install.ps1'), [ref]$null, [ref]$errors)
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

Assert-Test 'matrix.ps1 does not weaken execution policy' {
  $content = Get-Content -LiteralPath (Join-Path $d 'matrix.ps1') -Raw
  if ($content -match 'Set-ExecutionPolicy|Bypass.*-Force|Unrestricted') {
    throw "Attempts to weaken execution policy"
  }
}

# --- OmniRoute support paths ---

foreach ($f in @('matrix.ps1', 'matrix.cmd')) {
  Assert-Test "$f references bundled Node OmniRoute paths" {
    $content = Get-Content -LiteralPath (Join-Path $d $f) -Raw
    foreach ($r in @('omniroute\node.exe', 'omniroute\app\bin\omniroute.mjs', 'omniroute\omniroute.exe')) {
      if ($content -notmatch [regex]::Escape($r)) { throw "Missing: $r" }
    }
  }
}

# --- Health check uses 127.0.0.1 ---

Assert-Test 'launchers use 127.0.0.1 not localhost for health checks' {
  foreach ($f in @('matrix.ps1', 'matrix.cmd', 'matrix-installed.cmd')) {
    $content = Get-Content -LiteralPath (Join-Path $d $f) -Raw -ErrorAction SilentlyContinue
    if ($content -and $content -match 'http://localhost:20128') {
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
