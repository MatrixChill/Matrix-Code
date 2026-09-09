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
    $content | Should -Match 'MATRIX_POWERSHELL=powershell\.exe'
    $content | Should -Match 'where pwsh\.exe.*MATRIX_POWERSHELL=pwsh\.exe'
    $content | Should -Match 'MATRIX_POWERSHELL%.*-File'
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
    $content | Should -Match 'Get-MatchingListenerProcess'
    $content | Should -Match 'Get-NetTCPConnection -State Listen'
    $content | Should -Match '\$started -and -not \$ready'
    $content | Should -Match '\$parent\.Name -ne \$processInfo\.Name'
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

  It 'connection-refused probes should remain safe under strict mode' {
    $content = Get-Content -LiteralPath (Join-Path $DistDir 'matrix.ps1') -Raw
    $content | Should -Match "PSObject\.Properties\['Response'\]"
    $content | Should -Not -Match '\$_\.Exception\.Response\s+-and'
  }

  It 'an already-active OmniRoute listener on 20128 is reused, not restarted or killed' {
    $content = Get-Content -LiteralPath (Join-Path $DistDir 'matrix.ps1') -Raw
    $content | Should -Match '\$omniRouteHealth.*20128'
    $content | Should -Match 'Start-ManagedService'
    $content | Should -Match 'Running = \[bool\]\$running'
    $content | Should -Match '\$omniRoute\.Started'
    $content | Should -Match 'if \(\$omniRouteStarted -and \$null -ne \$omniRouteProcess\)'
  }

  It 'a normal/global omniroute installation is discovered via Get-Command' {
    $content = Get-Content -LiteralPath (Join-Path $DistDir 'matrix.ps1') -Raw
    $content | Should -Match 'Get-Command omniroute -ErrorAction SilentlyContinue'
    $content | Should -Match '\$globalOmni\.Source'
  }

  It 'with no vendored files, no global install and no listener, Matrix falls back' {
    $content = Get-Content -LiteralPath (Join-Path $DistDir 'matrix.ps1') -Raw
    $content | Should -Match 'OmniRoute is not available locally'
    $content | Should -Match '\$canStartNode -or \$canStartExe -or \$globalOmni'
  }
}

Describe 'Matrix API Support' {
  It 'the bundled config exposes only Matrix Free Auto and Matrix Coding Reliable through port 20260' {
    $content = Get-Content -LiteralPath (Join-Path $DistDir 'templates\opencode.omniroute.jsonc') -Raw
    $content | Should -Match 'matrix-api/matrix-coding-reliable'
    $content | Should -Match 'matrix-free-auto'
    $content | Should -Match 'matrix-coding-reliable'
    $content | Should -Match '127\.0\.0\.1:20260/v1'
    $content | Should -Not -Match '"omniroute"\s*:'
  }

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
  It 'matrix.ps1 should preserve a manual console and start a child TUI for hidden launchers' {
    $content = Get-Content -LiteralPath (Join-Path $DistDir 'matrix.ps1') -Raw
    $content | Should -Match 'tuiInCurrentConsole'
    $content | Should -Match '&\s+\$matrixExe\s+@args'
    $content | Should -Match 'Start-Process -FilePath \$matrixExe'
    $content | Should -Match '\$tuiWindow'
    $content | Should -Match 'MATRIX_TUI_WINDOW'
  }

  It 'matrix.ps1 should hide the TUI when output is redirected and show it for the desktop user' {
    $content = Get-Content -LiteralPath (Join-Path $DistDir 'matrix.ps1') -Raw
    $content | Should -Match 'IsOutputRedirected'
    $content | Should -Match '''Hidden'''
    (Get-Content -LiteralPath (Join-Path $DistDir 'matrix.cmd') -Raw) | Should -Match 'set\s+"MATRIX_TUI_WINDOW=Normal"'
  }

  It 'matrix.ps1 should call Start-Process without -ArgumentList when there are zero CLI arguments' {
    $content = Get-Content -LiteralPath (Join-Path $DistDir 'matrix.ps1') -Raw
    $content | Should -Match 'if \(\$tuiArgString\)'
    $content | Should -Match '\-ArgumentList \$tuiArgString'
    $content | Should -Match 'Start-Process -FilePath \$matrixExe -WindowStyle'
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

Describe 'OmniRoute Upstream Credential' {
  It 'matrix.ps1 should persist a supplied OmniRoute key and restore it on later launches' {
    $content = Get-Content -LiteralPath (Join-Path $DistDir 'matrix.ps1') -Raw
    $content | Should -Match 'omniroute-api\.cred'
    $content | Should -Match '\$env:OMNIROUTE_API_KEY = \$omnirouteApiKey'
    $content | Should -Not -Match '\$startInfo\.Arguments =.*OMNIROUTE_API_KEY'
    $content | Should -Not -Match 'Write-Host[^\r\n]*\$omnirouteApiKey'
  }

  It 'matrix.ps1 should not invent a gateway key or force REQUIRE_API_KEY' {
    $content = Get-Content -LiteralPath (Join-Path $DistDir 'matrix.ps1') -Raw
    $content | Should -Not -Match '\$env:REQUIRE_API_KEY\s*='
    $content | Should -Not -Match 'No OmniRoute API key was configured\. Generated'
    $content | Should -Not -Match 'Read-Host[^\r\n]*OmniRoute'
  }

  It 'the .matrix/state credential store should stay out of Git and the release build' {
    $rootIgnore = Get-Content -LiteralPath (Join-Path $RepoRoot '.gitignore') -Raw
    $rootIgnore | Should -Match '\.matrix'
    $tracked = & git -C $RepoRoot ls-files
    $tracked | Should -Not -Match '\.matrix'
    $build = Get-Content -LiteralPath (Join-Path $RepoRoot 'script\build-windows-distribution.ps1') -Raw
    $build | Should -Not -Match '\.matrix'
  }
}

Describe 'Test-LocalService HTTP Status Handling' {
  BeforeAll {
    $launcherPath = (Resolve-Path -LiteralPath (Join-Path $DistDir 'matrix.ps1')).Path
    $tokens = $null
    $parseErrors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($launcherPath, [ref]$tokens, [ref]$parseErrors)
    $fn = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Test-LocalService' }, $true)
    if (-not $fn) { throw 'Test-LocalService not found in matrix.ps1' }
    . ([scriptblock]::Create($fn.Extent.Text))

    # Serves one HTTP response with the given status code on a loopback port in
    # a child job, printing READY once the listener is bound. Proves
    # Test-LocalService's status handling over a real HTTP round trip.
    function Start-StubHttp {
      param([int]$Port, [int]$StatusCode)
      $job = Start-Job -Name "StubHttp-$Port" -ArgumentList $Port, $StatusCode -ScriptBlock {
        param($Port, $StatusCode)
        $tcp = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $Port)
        $tcp.Start()
        'READY'
        $client = $tcp.AcceptTcpClient()
        $stream = $client.GetStream()
        $buffer = New-Object byte[] 4096
        $null = $stream.Read($buffer, 0, $buffer.Length)
        $statusText = switch ($StatusCode) {
          200 { 'OK' }
          401 { 'Unauthorized' }
          404 { 'Not Found' }
          500 { 'Internal Server Error' }
          default { 'Status' }
        }
        $body = [System.Text.Encoding]::UTF8.GetBytes('{}')
        $head = [System.Text.Encoding]::ASCII.GetBytes("HTTP/1.1 $StatusCode $statusText`r`nContent-Length: $($body.Length)`r`nConnection: close`r`n`r`n")
        $stream.Write($head, 0, $head.Length)
        $stream.Write($body, 0, $body.Length)
        $stream.Flush()
        $client.Close()
        $tcp.Stop()
      }
      return $job
    }

    function Wait-StubReady {
      param($Job, [int]$TimeoutMs = 8000)
      $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
      do {
        $out = Receive-Job -Job $Job -Keep -ErrorAction SilentlyContinue
        if ($out -contains 'READY') { return $true }
        if ($Job.State -eq 'Failed') { return $false }
        Start-Sleep -Milliseconds 100
      } while ((Get-Date) -lt $deadline)
      return $false
    }
  }

  It 'returns $true for HTTP 200' {
    $job = Start-StubHttp -Port 49301 -StatusCode 200
    try {
      Wait-StubReady -Job $job | Should -BeTrue
      Test-LocalService -Uri 'http://127.0.0.1:49301/models' | Should -BeTrue
    } finally {
      Stop-Job -Job $job -ErrorAction SilentlyContinue
      Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
    }
  }

  It 'returns $false for HTTP 401 because the configured credential was rejected' {
    $job = Start-StubHttp -Port 49302 -StatusCode 401
    try {
      Wait-StubReady -Job $job | Should -BeTrue
      Test-LocalService -Uri 'http://127.0.0.1:49302/models' | Should -BeFalse
    } finally {
      Stop-Job -Job $job -ErrorAction SilentlyContinue
      Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
    }
  }

  It 'returns $false for HTTP 404' {
    $job = Start-StubHttp -Port 49303 -StatusCode 404
    try {
      Wait-StubReady -Job $job | Should -BeTrue
      Test-LocalService -Uri 'http://127.0.0.1:49303/models' | Should -BeFalse
    } finally {
      Stop-Job -Job $job -ErrorAction SilentlyContinue
      Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
    }
  }

  It 'returns $false for HTTP 500' {
    $job = Start-StubHttp -Port 49304 -StatusCode 500
    try {
      Wait-StubReady -Job $job | Should -BeTrue
      Test-LocalService -Uri 'http://127.0.0.1:49304/models' | Should -BeFalse
    } finally {
      Stop-Job -Job $job -ErrorAction SilentlyContinue
      Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
    }
  }
}
