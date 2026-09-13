<#
.SYNOPSIS
  Updates a persistent Windows Matrix Code development environment without ZIP packaging.

.DESCRIPTION
  FAST: run only the targeted tests and package typechecks for the current change.
  DEV: run this script, then launch Matrix Code with the reported matrix.ps1 path.
  RELEASE: run build-windows-distribution.ps1 only for a release candidate.

  The default environment is Matrix-Code-Dev beside the repository. Its .matrix
  directory is never removed. -Clean creates a separate timestamped environment
  for an isolated smoke test and leaves the main Dev environment untouched.
#>
param(
  [switch]$Clean,
  [string]$Destination
)

$ErrorActionPreference = 'Stop'
$startedAt = Get-Date
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$defaultDev = Join-Path (Split-Path -Parent $repo) 'Matrix-Code-Dev'
$dev = if ($Destination) {
  [IO.Path]::GetFullPath($Destination)
} elseif ($Clean) {
  Join-Path (Split-Path -Parent $repo) ("Matrix-Code-Dev-Clean-{0}" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
} else {
  $defaultDev
}

if ($dev.TrimEnd('\') -eq $repo.TrimEnd('\')) { throw 'The Dev environment cannot be the repository itself' }

function Get-SourceSnapshot {
  param([string[]]$Roots, [string[]]$Files = @())

  $items = @(
    foreach ($root in $Roots) {
      if (-not (Test-Path -LiteralPath $root)) { continue }
      Get-ChildItem -LiteralPath $root -Recurse -File
    }
    foreach ($file in $Files) {
      if (Test-Path -LiteralPath $file -PathType Leaf) { Get-Item -LiteralPath $file }
    }
  ) | Sort-Object FullName -Unique

  return @($items | ForEach-Object {
    [pscustomobject]@{
      path = $_.FullName.Substring($repo.Length + 1).Replace('\', '/')
      hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash
    }
  })
}

function Get-ChangedPaths {
  param([object[]]$Current, [object[]]$Previous)

  $before = @{}
  foreach ($item in @($Previous)) {
    if ($null -ne $item -and $item.path) { $before[[string]$item.path] = [string]$item.hash }
  }
  $after = @{}
  foreach ($item in @($Current)) {
    if ($null -ne $item -and $item.path) { $after[[string]$item.path] = [string]$item.hash }
  }

  return @(
    foreach ($item in @($Current)) {
      if (-not $before.ContainsKey($item.path) -or $before[$item.path] -ne $item.hash) { $item.path }
    }
    foreach ($item in @($Previous)) {
      if ($null -ne $item -and $item.path -and -not $after.ContainsKey($item.path)) { $item.path }
    }
  ) | Sort-Object -Unique
}

function Copy-DevFile {
  param([string]$Source, [string]$Target)

  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Target) | Out-Null
  Copy-Item -LiteralPath $Source -Destination $Target -Force
}

$releaseScript = Get-Content -LiteralPath (Join-Path $repo 'script\build-windows-distribution.ps1') -Raw
$omniRouteVersion = [regex]::Match($releaseScript, '\$omniRouteVersion = "([^"]+)"').Groups[1].Value
$nodeVersion = [regex]::Match($releaseScript, '\$nodeVersion = "([^"]+)"').Groups[1].Value
if (-not $omniRouteVersion -or -not $nodeVersion) { throw 'Could not read pinned OmniRoute/Node versions from the release build' }
$runtimeSignature = "omniroute-$omniRouteVersion-node-$nodeVersion"

$launcherRoot = Join-Path $repo 'distribution\windows'
$launcherFiles = @(Get-ChildItem -LiteralPath $launcherRoot -File | Select-Object -ExpandProperty FullName)
$launcherSnapshot = Get-SourceSnapshot -Roots @((Join-Path $launcherRoot 'templates')) -Files $launcherFiles
$cliSnapshot = Get-SourceSnapshot -Roots @(
  (Join-Path $repo 'packages\core\src'),
  (Join-Path $repo 'packages\tui\src'),
  (Join-Path $repo 'packages\opencode\src')
) -Files @(
  (Join-Path $repo 'packages\core\package.json'),
  (Join-Path $repo 'packages\tui\package.json'),
  (Join-Path $repo 'packages\opencode\package.json'),
  (Join-Path $repo 'packages\opencode\script\build.ts'),
  (Join-Path $repo 'bun.lock')
)
$voiceSnapshot = Get-SourceSnapshot -Roots @((Join-Path $repo 'script\voice')) -Files @((Join-Path $repo 'matrix-voice-helper.py'))

$statePath = Join-Path $dev '.matrix-dev-state.json'
$state = if (Test-Path -LiteralPath $statePath) { Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json } else { $null }
$launcherChanges = Get-ChangedPaths -Current $launcherSnapshot -Previous @($state.launchers)
$cliChanges = Get-ChangedPaths -Current $cliSnapshot -Previous @($state.cli)
$voiceChanges = Get-ChangedPaths -Current $voiceSnapshot -Previous @($state.voice)

Write-Host "Matrix Code Windows Dev: $dev"
$changed = @(@($launcherChanges) + @($cliChanges) + @($voiceChanges) | Where-Object { $_ })
Write-Host ("Changed: {0}" -f $(if (-not $state) { 'initial environment' } elseif ($changed.Count -eq 0) { 'none' } else { $changed -join ', ' }))
New-Item -ItemType Directory -Force -Path $dev | Out-Null

$voiceTarget = Join-Path $dev 'matrix-voice'
if (-not (Test-Path -LiteralPath (Join-Path $voiceTarget 'matrix-voice-helper.exe'))) {
  $voiceSource = @(
    (Join-Path $defaultDev 'matrix-voice'),
    (Join-Path $repo 'packages\opencode\dist\matrix-voice-build\dist\matrix-voice-helper'),
    (Join-Path $repo 'packages\opencode\dist\matrix-release\Matrix-Code-Windows-x64-Portable\matrix-voice')
  ) | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'matrix-voice-helper.exe') } | Select-Object -First 1
  if (-not $voiceSource) { throw 'No reusable Matrix Voice runtime found. Produce it once with the release build.' }
  Copy-Item -LiteralPath $voiceSource -Destination $voiceTarget -Recurse
  Write-Host 'Reused: Matrix Voice runtime (copied once)'
} elseif ($state -and $voiceChanges.Count -gt 0) {
  throw 'Matrix Voice sources changed. Use -Clean with a compatible prepared Voice runtime or build a release candidate.'
} else {
  Write-Host 'Reused: Matrix Voice runtime'
}

$omniRouteTarget = Join-Path $dev 'omniroute'
$omniRouteEntry = Join-Path $omniRouteTarget 'app\node_modules\omniroute\dist\server-ws.mjs'
$runtimeCurrent = $state -and $state.runtime -eq $runtimeSignature -and
  (Test-Path -LiteralPath (Join-Path $omniRouteTarget 'node.exe')) -and (Test-Path -LiteralPath $omniRouteEntry)
if (-not $runtimeCurrent) {
  if (Test-Path -LiteralPath $omniRouteTarget) {
    throw "Dev OmniRoute runtime is incompatible or untracked. Use -Clean; the main Dev environment was not changed."
  }
  $dependencyCache = Join-Path $repo 'tmp\matrix-dependencies'
  $nodeSource = Join-Path $dependencyCache "node-v$nodeVersion-win-x64\node.exe"
  $omniRouteSource = Join-Path $dependencyCache "omniroute-runtime-$omniRouteVersion-node-$nodeVersion\node_modules"
  if (-not (Test-Path -LiteralPath $nodeSource) -or -not (Test-Path -LiteralPath (Join-Path $omniRouteSource 'omniroute\dist\server-ws.mjs'))) {
    throw 'No compatible verified OmniRoute/Node cache found. Produce it once with the release build.'
  }
  New-Item -ItemType Directory -Force -Path (Join-Path $omniRouteTarget 'app') | Out-Null
  Copy-Item -LiteralPath $nodeSource -Destination (Join-Path $omniRouteTarget 'node.exe')
  Copy-Item -LiteralPath $omniRouteSource -Destination (Join-Path $omniRouteTarget 'app\node_modules') -Recurse
  $generatedEnv = Join-Path $omniRouteTarget 'app\node_modules\omniroute\.env'
  if (Test-Path -LiteralPath $generatedEnv) { Remove-Item -LiteralPath $generatedEnv -Force }
  Write-Host "Reused: verified OmniRoute $omniRouteVersion + Node $nodeVersion (copied once)"
} else {
  Write-Host "Reused: OmniRoute $omniRouteVersion + Node $nodeVersion"
}

$builtCli = Join-Path $repo 'packages\opencode\dist\opencode-windows-x64\bin\opencode.exe'
$matrixExe = Join-Path $dev 'matrix.exe'
$needCli = -not $state -or $cliChanges.Count -gt 0 -or -not (Test-Path -LiteralPath $matrixExe)
if ($needCli) {
  $newestCliSource = @($cliSnapshot | ForEach-Object { Get-Item -LiteralPath (Join-Path $repo $_.path) } | Sort-Object LastWriteTime -Descending | Select-Object -First 1)
  $canReuseOutput = -not $state -and (Test-Path -LiteralPath $builtCli) -and
    (Get-Item -LiteralPath $builtCli).LastWriteTime -ge $newestCliSource[0].LastWriteTime
  if (-not $canReuseOutput) {
    & bun run --cwd (Join-Path $repo 'packages\opencode') build --single --skip-install --skip-embed-web-ui
    if ($LASTEXITCODE -ne 0) { throw 'Windows Dev CLI build failed' }
    Write-Host 'Rebuilt: Windows x64 CLI/TUI (single target, Web UI embedding skipped)'
  } else {
    Write-Host 'Reused: current Windows x64 CLI output'
  }
  Copy-DevFile -Source $builtCli -Target $matrixExe
} else {
  Write-Host 'Reused: Dev matrix.exe'
}

$launcherCopy = if ($state) { $launcherChanges } else { @($launcherSnapshot.path) }
foreach ($path in $launcherCopy) {
  $source = Join-Path $repo $path
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { continue }
  $relative = $path.Substring('distribution/windows/'.Length)
  Copy-DevFile -Source $source -Target (Join-Path $dev $relative)
}
if ($launcherCopy.Count -gt 0) {
  Write-Host ("Updated launchers: {0}" -f ($launcherCopy -join ', '))
} else {
  Write-Host 'Reused: Windows launchers/templates'
}
Copy-DevFile -Source (Join-Path $repo 'LICENSE') -Target (Join-Path $dev 'LICENSE')

$nextState = [pscustomobject]@{
  runtime = $runtimeSignature
  launchers = $launcherSnapshot
  cli = $cliSnapshot
  voice = $voiceSnapshot
  updated = (Get-Date).ToUniversalTime().ToString('o')
}
[IO.File]::WriteAllText($statePath, ($nextState | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))

Write-Host ("Ready: {0}" -f (Join-Path $dev 'matrix.ps1'))
Write-Host ("Total time: {0:n1}s" -f ((Get-Date) - $startedAt).TotalSeconds)
