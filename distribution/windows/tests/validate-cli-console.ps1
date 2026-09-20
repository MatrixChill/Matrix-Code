# Run with Windows PowerShell 5.1; Node is used only as a native argv probe.
# Exercises the source launchers without a distribution build or live services.
$ErrorActionPreference = 'Stop'
if (Get-NetTCPConnection -State Listen -LocalPort 20128,20260 -ErrorAction SilentlyContinue) {
  throw 'Run this isolated console test with ports 20128 and 20260 free.'
}
$root = Join-Path ([IO.Path]::GetTempPath()) ('matrix-cli-console-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
Copy-Item (Join-Path $PSScriptRoot '..\matrix.cmd'), (Join-Path $PSScriptRoot '..\matrix.ps1') -Destination $root
Copy-Item (Get-Command node.exe -ErrorAction Stop).Source -Destination (Join-Path $root 'matrix.exe')

$savedPath = $env:PATH
$savedApi = $env:MATRIX_API_ENABLED
$savedWindow = $env:MATRIX_TUI_WINDOW
$pwsh = Get-Command pwsh.exe -ErrorAction SilentlyContinue
try {
  $env:MATRIX_API_ENABLED = 'false'
  # Prove argument mode overrides a window setting inherited from the caller.
  $env:MATRIX_TUI_WINDOW = 'Normal'
  $hosts = @($PSHOME)
  if ($pwsh) { $hosts += Split-Path -Parent $pwsh.Source }
  foreach ($hostDirectory in $hosts) {
    # No bundled gateway and no global npm path: no real provider is launched.
    $env:PATH = "$hostDirectory;$env:SystemRoot\System32;$env:SystemRoot;$PSHOME"
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $env:ComSpec
    $probe = "process.argv.slice(1).forEach((x,i)=>console.log('ARG'+i+'='+x));console.error('STDERR_VISIBLE');process.exit(23)"
    $info.Arguments = '/d /s /c ""' + (Join-Path $root 'matrix.cmd') + '" -e "' + $probe + '" -- probe "alpha beta" "say \"hello\" world""'
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $process = [Diagnostics.Process]::Start($info)
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(15000)) {
      $process.Kill()
      throw 'CLI console test timed out'
    }
    $output = $stdout.Result
    $errorOutput = $stderr.Result
    if ($process.ExitCode -ne 23) { throw "Exit code was $($process.ExitCode), expected 23" }
    foreach ($expected in @('ARG0=probe', 'ARG1=alpha beta', 'ARG2=say "hello" world')) {
      if (-not $output.Contains($expected)) { throw "Missing stdout: $expected; received: $output" }
    }
    if (-not $errorOutput.Contains('STDERR_VISIBLE')) { throw 'stderr was not inherited' }
    Write-Output "PASS: attached stdout/stderr, spaces/quotes, exit 23 ($hostDirectory)"
    $process.Dispose()
  }
} finally {
  $env:PATH = $savedPath
  $env:MATRIX_API_ENABLED = $savedApi
  $env:MATRIX_TUI_WINDOW = $savedWindow
}
Write-Output "Temporary test fixture: $root"
