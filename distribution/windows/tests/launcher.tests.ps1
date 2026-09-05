<#
.SYNOPSIS
  Pester tests for Windows portable launcher behavior.

.DESCRIPTION
  Comprehensive tests for the portable launcher scripts. Requires Pester 5+.
  Run with: Invoke-Pester -Path .\tests\launcher.tests.ps1

  Tests cover:
  - Script syntax validation
  - Portable layout structure
  - Environment variable configuration
  - Path resolution (no hardcoded drives)
  - OmniRoute discovery logic
  - Security invariants
  - Build script integration
#>

BeforeAll {
  $script:DistDir   = Split-Path -Parent $PSScriptRoot
  $script:RepoRoot  = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..\..')).Path
}

Describe 'Launcher Script Syntax' {
  It '<file> should have valid PowerShell syntax' -ForEach @(
    @{ File = 'matrix.ps1' }
    @{ File = 'matrix-personal.ps1' }
    @{ File = 'matrix-omniroute-health.ps1' }
    @{ File = 'install.ps1' }
  ) {
    $path = Join-Path $DistDir $File
    $errors = $null
    $null = [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$null, [ref]$errors)
    $errors | Should -BeNullOrEmpty
  }
}

Describe 'Portable Layout Structure' {
  It 'should contain all expected launcher files' {
    $expected = @('matrix.cmd', 'matrix.ps1', 'matrix-personal.ps1', 'matrix-installed.cmd', 'install.ps1')
    foreach ($f in $expected) {
      (Join-Path $DistDir $f) | Should -Exist
    }
  }

  It 'should contain templates directory with omniroute config' {
    (Join-Path $DistDir 'templates\opencode.omniroute.jsonc') | Should -Exist
  }
}

Describe 'Path Resolution — No Hardcoded Drives' {
  It '<file> should not contain hardcoded drive letters' -ForEach @(
    @{ File = 'matrix.ps1' }
    @{ File = 'matrix.cmd' }
    @{ File = 'matrix-personal.ps1' }
    @{ File = 'matrix-installed.cmd' }
  ) {
    $content = Get-Content -LiteralPath (Join-Path $DistDir $File) -Raw
    $content | Should -Not -Match '[A-Z]:\\'
  }
}

Describe 'Environment Variables' {
  It 'matrix.ps1 should set all XDG and OpenCode env vars' {
    $content = Get-Content -LiteralPath (Join-Path $DistDir 'matrix.ps1') -Raw
    @('XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
      'OPENCODE_CONFIG_DIR', 'MATRIX_VOICE_HELPER', 'MATRIX_VOICE_MODEL_DIR', 'MATRIX_PORTABLE_ROOT') |
      ForEach-Object { $content | Should -Match $_ }
  }

  It 'matrix.ps1 should use $PSScriptRoot or MyInvocation for root resolution' {
    $content = Get-Content -LiteralPath (Join-Path $DistDir 'matrix.ps1') -Raw
    ($content -match '\$PSScriptRoot' -or $content -match 'MyInvocation') | Should -BeTrue
  }
}

Describe 'OmniRoute Support' {
  It 'matrix.ps1 should reference standalone exe, Node runtime, and Node entry' {
    $content = Get-Content -LiteralPath (Join-Path $DistDir 'matrix.ps1') -Raw
    @('omniroute\omniroute.exe', 'omniroute\node.exe', 'omniroute\app\bin\omniroute.mjs') |
      ForEach-Object { $content | Should -Match ([regex]::Escape($_)) }
  }

  It 'matrix.cmd should launch matrix.ps1 invisibly and without execution-policy flags' {
    $content = Get-Content -LiteralPath (Join-Path $DistDir 'matrix.cmd') -Raw
    $content | Should -Match 'matrix\.ps1'
    $content | Should -Match 'powershell\.exe.*-File'
    $content | Should -Match '-WindowStyle Hidden'
    $content | Should -Not -Match 'ExecutionPolicy'
  }

  It 'matrix.installed.cmd should reference standalone exe, Node runtime, and Node entry' {
    $content = Get-Content -LiteralPath (Join-Path $DistDir 'matrix-installed.cmd') -Raw
    @('omniroute\omniroute.exe', 'omniroute\node.exe', 'omniroute\app\bin\omniroute.mjs') |
      ForEach-Object { $content | Should -Match ([regex]::Escape($_)) }
  }

  It 'matrix.ps1 should use PID tracking for process cleanup' {
    $content = Get-Content -LiteralPath (Join-Path $DistDir 'matrix.ps1') -Raw
    $content | Should -Match 'omniroute\.pid'
    $content | Should -Match '\.Kill\(\)'
  }

  It 'launchers should use 127.0.0.1 not localhost for health checks' {
    $files = @('matrix.ps1', 'matrix.cmd', 'matrix-installed.cmd')
    foreach ($f in $files) {
      $content = Get-Content -LiteralPath (Join-Path $DistDir $f) -Raw -ErrorAction SilentlyContinue
      if ($content) {
        $content | Should -Not -Match 'http://localhost:20128'
        $content | Should -Not -Match 'http://localhost:20260'
      }
    }
  }
}

Describe 'Matrix API Support' {
  It 'matrix.ps1 should reference the Matrix API env surface and port 20260' {
    $content = Get-Content -LiteralPath (Join-Path $DistDir 'matrix.ps1') -Raw
    @('20260', 'MATRIX_API_KEY', 'MATRIX_API_ENABLED', 'MATRIX_API_PORT', 'matrix-api.pid') |
      ForEach-Object { $content | Should -Match ([regex]::Escape($_)) }
  }

  It 'matrix.ps1 should start the Matrix API via the headless matrix-api subcommand' {
    $content = Get-Content -LiteralPath (Join-Path $DistDir 'matrix.ps1') -Raw
    $content | Should -Match '\$startInfo\.Arguments = ''matrix-api'''
  }

  It 'matrix.ps1 should fail closed only when the API is explicitly disabled' {
    $content = Get-Content -LiteralPath (Join-Path $DistDir 'matrix.ps1') -Raw
    $content | Should -Match 'MATRIX_API_ENABLED=false'
    $content | Should -Match 'fail closed'
  }

  It 'matrix.ps1 should persist and restore the Matrix API key once, never print it' {
    $content = Get-Content -LiteralPath (Join-Path $DistDir 'matrix.ps1') -Raw
    @('matrix-api.cred', 'ConvertFrom-SecureString', 'ConvertTo-SecureString', 'New-MatrixApiKey') |
      ForEach-Object { $content | Should -Match ([regex]::Escape($_)) }
    $content | Should -Not -Match 'Write-Host[^\r\n]*\$matrixApiKey'
    $content | Should -Not -Match 'Set-Content[^\r\n]*\$matrixApiKey'
  }

  It 'matrix.ps1 should never print the Matrix API key value' {
    $content = Get-Content -LiteralPath (Join-Path $DistDir 'matrix.ps1') -Raw
    $content | Should -Not -Match 'Write-Host[^\r\n]*\$matrixApiKey'
    $content | Should -Not -Match 'Set-Content[^\r\n]*\$matrixApiKey'
  }

  It 'matrix.ps1 should pass the API key only via environment, never the command line' {
    $content = Get-Content -LiteralPath (Join-Path $DistDir 'matrix.ps1') -Raw
    $content | Should -Not -Match '\$startInfo\.Arguments =.*MATRIX_API_KEY'
  }

  It 'matrix.ps1 should track the Matrix API PID for targeted cleanup' {
    $content = Get-Content -LiteralPath (Join-Path $DistDir 'matrix.ps1') -Raw
    $content | Should -Match 'matrix-api\.pid'
    $content | Should -Match '\$matrixApiStarted -and \$matrixApiPid'
  }
}

Describe 'Security Invariants' {
  It 'no launcher should contain plaintext API key patterns' {
    $patterns = @('sk-', 'ghp_', 'AKIA', 'Authorization: Bearer', 'xoxb-')
    $files = @('matrix.ps1', 'matrix.cmd', 'matrix-personal.ps1', 'matrix-installed.cmd')
    foreach ($f in $files) {
      $content = Get-Content -LiteralPath (Join-Path $DistDir $f) -Raw -ErrorAction SilentlyContinue
      if (-not $content) { continue }
      foreach ($pat in $patterns) {
        $content | Should -Not -Match [regex]::Escape($pat)
      }
    }
  }

  It 'matrix.ps1 should not weaken execution policy' {
    $content = Get-Content -LiteralPath (Join-Path $DistDir 'matrix.ps1') -Raw
    $content | Should -Not -Match 'Set-ExecutionPolicy'
    $content | Should -Not -Match 'Bypass.*-Force'
    $content | Should -Not -Match 'ExecutionPolicy Bypass'
  }

  It 'no launcher should use execution-policy flags' {
    $files = @('matrix.ps1', 'matrix.cmd', 'matrix-personal.ps1', 'matrix-installed.cmd', 'install.ps1')
    foreach ($f in $files) {
      $content = Get-Content -LiteralPath (Join-Path $DistDir $f) -Raw -ErrorAction SilentlyContinue
      if ($content) {
        $content | Should -Not -Match 'ExecutionPolicy[ =][^"]*Bypass'
        $content | Should -Not -Match 'PowerShell.*-ExecutionPolicy'
      }
    }
  }
}

Describe 'Launcher Window Behaviour' {
  It 'matrix.ps1 should start the TUI with Start-Process so the launcher window stays hidden' {
    $content = Get-Content -LiteralPath (Join-Path $DistDir 'matrix.ps1') -Raw
    $content | Should -Match 'Start-Process -FilePath \$matrixExe'
    $content | Should -Match '\$tuiWindow'
    $content | Should -Match 'MATRIX_TUI_WINDOW'
  }

  It 'matrix.ps1 should hide the TUI when output is redirected and show it for the desktop user' {
    $content = Get-Content -LiteralPath (Join-Path $DistDir 'matrix.ps1') -Raw
    $content | Should -Match 'IsOutputRedirected'
    $content | Should -Match '''Normal'''
  }
}

Describe 'Build Script Integration' {
  It 'build script should copy matrix.ps1 to portable distribution' {
    $buildScript = Join-Path $RepoRoot 'script\build-windows-distribution.ps1'
    $content = Get-Content -LiteralPath $buildScript -Raw
    $content | Should -Match 'matrix\.ps1'
  }

  It 'build script should run PowerShell launcher smoke test' {
    $buildScript = Join-Path $RepoRoot 'script\build-windows-distribution.ps1'
    $content = Get-Content -LiteralPath $buildScript -Raw
    $content | Should -Match 'matrix\.ps1.*--version'
  }
}
