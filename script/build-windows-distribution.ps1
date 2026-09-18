param(
  [switch]$SkipCliBuild,
  [switch]$SkipVoiceBuild,
  [switch]$SkipVoiceSelfTest,
  [string]$MatrixVersion = '1.0.2'
)

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$dist = Join-Path $repo "packages\opencode\dist"
$release = Join-Path $dist "matrix-release"
$voiceBuild = Join-Path $dist "matrix-voice-build"
$dependencyCache = Join-Path $repo "tmp\matrix-dependencies"

$omniRouteVersion = "3.8.50"
$omniRouteUrl = "https://registry.npmjs.org/omniroute/-/omniroute-$omniRouteVersion.tgz"
$omniRouteSha256 = "738c58af1faae8c57eb643a939d1191f8d7e083d9295ef61687d2bff04878c29"
$nodeVersion = "24.13.0"
$nodeUrl = "https://nodejs.org/dist/v$nodeVersion/node-v$nodeVersion-win-x64.zip"
$nodeSha256 = "ca2742695be8de44027d71b3f53a4bdb36009b95575fe1ae6f7f0b5ce091cb88"

function Test-MatrixPathInside {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [Parameter(Mandatory = $true)]
    [string]$Root
  )

  # Directory-boundary comparison: "C:\release-evil" must never satisfy root "C:\release".
  $fullPath = [IO.Path]::GetFullPath($Path)
  $fullRoot = [IO.Path]::GetFullPath($Root)
  if (-not $fullRoot.EndsWith([string][IO.Path]::DirectorySeparatorChar)) {
    $fullRoot += [IO.Path]::DirectorySeparatorChar
  }
  return $fullPath.StartsWith($fullRoot, [StringComparison]::OrdinalIgnoreCase)
}

function Get-VerifiedDependency {
  param(
    [string]$Uri,
    [string]$Path,
    [string]$Sha256
  )

  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
  if (-not (Test-Path -LiteralPath $Path) -or (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash -ne $Sha256) {
    $partial = "$Path.partial"
    Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue
    Invoke-WebRequest -Uri $Uri -OutFile $partial -UseBasicParsing
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $partial).Hash -ne $Sha256) {
      Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue
      throw "Downloaded dependency failed SHA-256 validation: $([IO.Path]::GetFileName($Path))"
    }
    Move-Item -LiteralPath $partial -Destination $Path -Force
  }
  return $Path
}

function Remove-MatrixNonRuntimeFiles {
  param(
    [Parameter(Mandatory = $true)]
    [string]$TargetDir
  )

  if (-not (Test-Path -LiteralPath $TargetDir)) {
    throw "Target directory for pruning does not exist: $TargetDir"
  }

  # Fail closed: pruning may only ever touch the disposable release tree.
  $releaseRoot = (Resolve-Path -LiteralPath $release).Path
  $resolvedTarget = (Resolve-Path -LiteralPath $TargetDir).Path
  if (-not (Test-MatrixPathInside -Path $resolvedTarget -Root $releaseRoot)) {
    throw "Pruning target escaped the disposable release tree: $resolvedTarget"
  }

  Write-Host "Pruning non-runtime files and non-Windows native binaries from: $TargetDir"
  $initialFiles = @(Get-ChildItem -LiteralPath $TargetDir -Recurse -File)
  $initialCount = $initialFiles.Count
  $initialBytes = ($initialFiles | Measure-Object -Property Length -Sum).Sum

  $prunedMapsCount = 0
  $prunedMapsBytes = 0
  $prunedDocsCount = 0
  $prunedDocsBytes = 0
  $prunedNativeCount = 0
  $prunedNativeBytes = 0

  # 1. Source maps (*.map)
  $mapFiles = @(Get-ChildItem -LiteralPath $TargetDir -Recurse -File -Filter "*.map")
  foreach ($f in $mapFiles) {
    $prunedMapsBytes += $f.Length
    $prunedMapsCount++
    Remove-Item -LiteralPath $f.FullName -Force
  }

  # 2. Tests, docs, examples, and benchmarks directories
  $devDirNames = @("test", "tests", "__tests__", "testing", "example", "examples", "benchmark", "benchmarks", "docs", "doc")
  $devDirs = @(Get-ChildItem -LiteralPath $TargetDir -Recurse -Directory | Where-Object { $devDirNames -contains $_.Name.ToLowerInvariant() })
  foreach ($d in $devDirs) {
    if (Test-Path -LiteralPath $d.FullName) {
      $filesInDir = @(Get-ChildItem -LiteralPath $d.FullName -Recurse -File)
      foreach ($f in $filesInDir) {
        $prunedDocsBytes += $f.Length
        $prunedDocsCount++
      }
      Remove-Item -LiteralPath $d.FullName -Recurse -Force
    }
  }

  # 3. Foreign native binaries (Linux, macOS, non-x64 Windows)
  # Keep LICENSE/LICENCE/NOTICE/COPYING files completely intact.
  # Explicitly prune non-Windows native directories and files:
  # - onnxruntime-node darwin, linux, and win32\arm64
  # - koffi platforms on the explicit incompatible deny-list
  # - foreign native extensions (.dylib, .so)
  $foreignNativeDirs = @(Get-ChildItem -LiteralPath $TargetDir -Recurse -Directory | Where-Object {
    $norm = $_.FullName.Replace('\', '/')
    # onnxruntime-node platform directories
    ($norm -match '/onnxruntime-node/bin/napi-v6/(darwin|linux|win32/arm64)$') -or
    # koffi: explicit deny-list of known incompatible platforms. Unknown/future
    # platform directories are preserved, and win32_x64 is never matched.
    ($norm -match '/koffi/build/koffi/(?:darwin_x64|darwin_arm64|linux_[^/]+|freebsd_x64|openbsd_x64|win32_ia32|win32_arm64)$')
  })

  foreach ($d in $foreignNativeDirs) {
    if (Test-Path -LiteralPath $d.FullName) {
      $filesInDir = @(Get-ChildItem -LiteralPath $d.FullName -Recurse -File)
      foreach ($f in $filesInDir) {
        $prunedNativeBytes += $f.Length
        $prunedNativeCount++
      }
      Remove-Item -LiteralPath $d.FullName -Recurse -Force
    }
  }

  # Any standalone foreign dynamic libraries (.dylib, .so) outside preserved folders
  $foreignExtFiles = @(Get-ChildItem -LiteralPath $TargetDir -Recurse -File | Where-Object {
    $_.Extension -in @(".dylib", ".so")
  })
  foreach ($f in $foreignExtFiles) {
    if (Test-Path -LiteralPath $f.FullName) {
      $prunedNativeBytes += $f.Length
      $prunedNativeCount++
      Remove-Item -LiteralPath $f.FullName -Force
    }
  }

  $finalFiles = @(Get-ChildItem -LiteralPath $TargetDir -Recurse -File)
  $finalCount = $finalFiles.Count
  $finalBytes = ($finalFiles | Measure-Object -Property Length -Sum).Sum

  Write-Host "Pruning statistics:"
  Write-Host ("  Source maps:      {0} files, {1:N1} MiB" -f $prunedMapsCount, ($prunedMapsBytes / 1MB))
  Write-Host ("  Tests/docs/dev:   {0} files, {1:N1} MiB" -f $prunedDocsCount, ($prunedDocsBytes / 1MB))
  Write-Host ("  Foreign binaries: {0} files, {1:N1} MiB" -f $prunedNativeCount, ($prunedNativeBytes / 1MB))
  Write-Host ("  Total removed:    {0} files, {1:N1} MiB" -f ($initialCount - $finalCount), (($initialBytes - $finalBytes) / 1MB))
  Write-Host ("  Remaining:        {0} files, {1:N1} MiB" -f $finalCount, ($finalBytes / 1MB))
}


if (-not $SkipCliBuild) {
  $previousMatrixVersion = $env:MATRIX_VERSION
  # Windows PowerShell 5.1 raises a terminating NativeCommandError when a native
  # process writes to stderr while $ErrorActionPreference is "Stop" — even when
  # the process exits 0. Bun writes ordinary progress and warnings to stderr, so
  # success is judged solely by its real exit code, captured immediately below.
  $previousErrorActionPreference = $ErrorActionPreference
  $bunExitCode = $null
  try {
    $env:MATRIX_VERSION = $MatrixVersion
    $ErrorActionPreference = "Continue"
    & bun run --cwd (Join-Path $repo "packages\opencode") build --single --skip-install
    $bunExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
    if ($null -eq $previousMatrixVersion) {
      Remove-Item Env:MATRIX_VERSION -ErrorAction SilentlyContinue
    } else {
      $env:MATRIX_VERSION = $previousMatrixVersion
    }
  }
  if ($bunExitCode -ne 0) { throw "Windows CLI build failed" }
}

$cli = Join-Path $dist "opencode-windows-x64\bin\opencode.exe"
if (-not (Test-Path -LiteralPath $cli)) { throw "Windows x64 CLI binary not found: $cli" }

if (-not $SkipVoiceBuild) {
  if (Test-Path -LiteralPath $voiceBuild) { Remove-Item -LiteralPath $voiceBuild -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $voiceBuild | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $voiceBuild "spec") | Out-Null
  $voiceVenv = Join-Path $voiceBuild "venv"
  & python -m venv $voiceVenv
  if ($LASTEXITCODE -ne 0) { throw "Matrix Voice build environment creation failed" }
  $voicePython = Join-Path $voiceVenv "Scripts\python.exe"
  & $voicePython -m ensurepip --upgrade
  if ($LASTEXITCODE -ne 0) { throw "Matrix Voice build pip bootstrap failed" }
  & $voicePython -m pip install --disable-pip-version-check --no-input -r (Join-Path $repo "script\voice\requirements-build.txt")
  if ($LASTEXITCODE -ne 0) { throw "Matrix Voice build dependencies installation failed" }

  $model = Join-Path $voiceBuild "model"
  & $voicePython (Join-Path $repo "script\voice\download-model.py") --output $model
  if ($LASTEXITCODE -ne 0) { throw "Matrix Voice model download failed" }
  $modelCache = Join-Path $model ".cache"
  if (Test-Path -LiteralPath $modelCache) { Remove-Item -LiteralPath $modelCache -Recurse -Force }

  & $voicePython -m PyInstaller --noconfirm --clean --onedir --name matrix-voice-helper `
    --distpath (Join-Path $voiceBuild "dist") `
    --workpath (Join-Path $voiceBuild "work") `
    --specpath (Join-Path $voiceBuild "spec") `
    --collect-all faster_whisper `
    --collect-all ctranslate2 `
    --collect-all sounddevice `
    (Join-Path $repo "matrix-voice-helper.py")
  if ($LASTEXITCODE -ne 0) { throw "Matrix Voice executable build failed" }

  Copy-Item -LiteralPath $model -Destination (Join-Path $voiceBuild "dist\matrix-voice-helper\model") -Recurse
}

$voice = Join-Path $voiceBuild "dist\matrix-voice-helper"
if (-not (Test-Path -LiteralPath (Join-Path $voice "matrix-voice-helper.exe"))) {
  throw "Matrix Voice executable not found: $voice"
}

if (-not $SkipVoiceSelfTest) {
  & (Join-Path $voice "matrix-voice-helper.exe") --self-test --model-dir (Join-Path $voice "model")
  if ($LASTEXITCODE -ne 0) { throw "Matrix Voice self-test failed" }
}

if (-not (Test-MatrixPathInside -Path $release -Root $dist)) {
  throw "Release path escaped the Matrix build output root: $release"
}
if (Test-Path -LiteralPath $release) { Remove-Item -LiteralPath $release -Recurse -Force }
New-Item -ItemType Directory -Force -Path $release | Out-Null

$standard = Join-Path $release "Matrix-Code-Windows-x64"
$portable = Join-Path $release "Matrix-Code-Windows-x64-Portable"
New-Item -ItemType Directory -Force -Path $standard | Out-Null
New-Item -ItemType Directory -Force -Path $portable | Out-Null

foreach ($stage in @($standard, $portable)) {
  Copy-Item -LiteralPath $cli -Destination (Join-Path $stage "matrix.exe")
  Copy-Item -LiteralPath $voice -Destination (Join-Path $stage "matrix-voice") -Recurse
  Copy-Item -LiteralPath (Join-Path $repo "LICENSE") -Destination $stage
  Copy-Item -LiteralPath (Join-Path $repo "distribution\windows\README.txt") -Destination $stage
}

# Standard (installed) distribution
Copy-Item -LiteralPath (Join-Path $repo "distribution\windows\install.ps1") -Destination $standard
Copy-Item -LiteralPath (Join-Path $repo "distribution\windows\matrix-installed.cmd") -Destination $standard

# Portable distribution
Copy-Item -LiteralPath (Join-Path $repo "distribution\windows\matrix.cmd") -Destination $portable
Copy-Item -LiteralPath (Join-Path $repo "distribution\windows\matrix.ps1") -Destination $portable
Copy-Item -LiteralPath (Join-Path $repo "distribution\windows\matrix-personal.ps1") -Destination $portable
Copy-Item -LiteralPath (Join-Path $repo "distribution\windows\verify-matrix-rc.ps1") -Destination $portable
Copy-Item -LiteralPath (Join-Path $repo "distribution\windows\templates") -Destination $portable -Recurse

# Bundle the official CLI package with a pinned Node runtime. npm is used only
# while producing the release; the resulting Portable never needs a global
# OmniRoute, Node.js, npm, or a first-run download.
$omniRoutePackage = Get-VerifiedDependency `
  -Uri $omniRouteUrl `
  -Path (Join-Path $dependencyCache "omniroute-$omniRouteVersion.tgz") `
  -Sha256 $omniRouteSha256
$nodeArchive = Get-VerifiedDependency `
  -Uri $nodeUrl `
  -Path (Join-Path $dependencyCache "node-v$nodeVersion-win-x64.zip") `
  -Sha256 $nodeSha256
$nodeRoot = Join-Path $dependencyCache "node-v$nodeVersion-win-x64"
if (-not (Test-Path -LiteralPath (Join-Path $nodeRoot "node.exe"))) {
  Expand-Archive -LiteralPath $nodeArchive -DestinationPath $dependencyCache -Force
}
$omniRouteRuntime = Join-Path $dependencyCache "omniroute-runtime-$omniRouteVersion-node-$nodeVersion"
$omniRouteMarker = Join-Path $omniRouteRuntime ".complete"
if (-not (Test-Path -LiteralPath $omniRouteMarker)) {
  if (Test-Path -LiteralPath $omniRouteRuntime) { Remove-Item -LiteralPath $omniRouteRuntime -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $omniRouteRuntime | Out-Null
  & (Join-Path $nodeRoot "npm.cmd") install --prefix $omniRouteRuntime $omniRoutePackage --omit=dev --no-audit --no-fund --package-lock=false
  if ($LASTEXITCODE -ne 0) { throw "OmniRoute runtime installation failed" }
  if (-not (Test-Path -LiteralPath (Join-Path $omniRouteRuntime "node_modules\omniroute\dist\server-ws.mjs"))) {
    throw "Official OmniRoute standalone server entry point was not installed"
  }
  Set-Content -LiteralPath $omniRouteMarker -Value "$omniRouteVersion`n$nodeVersion" -Encoding ascii
}
$omniRouteStage = Join-Path $portable "omniroute"
New-Item -ItemType Directory -Force -Path $omniRouteStage | Out-Null
Copy-Item -LiteralPath (Join-Path $nodeRoot "node.exe") -Destination (Join-Path $omniRouteStage "node.exe")
New-Item -ItemType Directory -Force -Path (Join-Path $omniRouteStage "app") | Out-Null
Copy-Item -LiteralPath (Join-Path $omniRouteRuntime "node_modules") -Destination (Join-Path $omniRouteStage "app\node_modules") -Recurse

# OmniRoute's npm install generates a local build-generated .env with runtime-only signing
# secrets. The build-generated .env file must never become release material;
# the launcher supplies fresh protected credentials through the child
# environment, so the build-generated file must never become release material.
$omniRouteGeneratedEnv = Join-Path $omniRouteStage "app\node_modules\omniroute\.env"
if (Test-Path -LiteralPath $omniRouteGeneratedEnv) {
  Remove-Item -LiteralPath $omniRouteGeneratedEnv -Force
}
Get-ChildItem -LiteralPath $omniRouteStage -Filter '.env' -File -Recurse -Force |
  Remove-Item -Force

# Prune source maps, non-runtime docs/tests/examples, and foreign native binaries
Remove-MatrixNonRuntimeFiles -TargetDir (Join-Path $omniRouteStage "app\node_modules")


$standardZip = Join-Path $release "Matrix-Code-Windows-x64.zip"
$portableZip = Join-Path $release "Matrix-Code-Windows-x64-Portable-v$MatrixVersion-RC.zip"
Add-Type -AssemblyName System.IO.Compression.FileSystem
if (Test-Path -LiteralPath $standardZip) { Remove-Item -LiteralPath $standardZip -Force }
if (Test-Path -LiteralPath $portableZip) { Remove-Item -LiteralPath $portableZip -Force }
[IO.Compression.ZipFile]::CreateFromDirectory(
  $standard,
  $standardZip,
  [IO.Compression.CompressionLevel]::Optimal,
  $false
)
[IO.Compression.ZipFile]::CreateFromDirectory(
  $portable,
  $portableZip,
  [IO.Compression.CompressionLevel]::Optimal,
  $false
)

$portableArchive = [IO.Compression.ZipFile]::OpenRead($portableZip)
try {
  $portableEntries = @($portableArchive.Entries | ForEach-Object { $_.FullName.Replace('\', '/') })
  if ($portableEntries -notcontains "omniroute/node.exe") { throw "Portable ZIP is missing its Node.js runtime" }
  if ($portableEntries -notcontains "omniroute/app/node_modules/omniroute/dist/server-ws.mjs") { throw "Portable ZIP is missing OmniRoute" }
  if ($portableEntries | Where-Object { $_ -match '(^|/)\.env$' }) {
    throw "Portable ZIP contains a .env file"
  }
} finally {
  $portableArchive.Dispose()
}

# Smoke tests
& (Join-Path $standard "matrix.exe") --version
if ($LASTEXITCODE -ne 0) { throw "Installed distribution smoke test failed" }

# Launcher smoke tests run from a disposable path-with-spaces copy so validation
# can never seed runtime state or credentials into the release candidate.
$smokeTest = Join-Path $release "smoke test portable"
Copy-Item -LiteralPath $portable -Destination $smokeTest -Recurse
try {
  & cmd.exe /d /c (Join-Path $smokeTest "matrix.cmd") --version
  if ($LASTEXITCODE -ne 0) { throw "Portable distribution CMD launcher smoke test failed" }
  & powershell -NoProfile -File (Join-Path $smokeTest "matrix.ps1") --version
  if ($LASTEXITCODE -ne 0) { throw "Portable distribution PowerShell launcher smoke test failed" }
} finally {
  Remove-Item -LiteralPath $smokeTest -Recurse -Force -ErrorAction SilentlyContinue
}

$checksums = @($standardZip, $portableZip) | ForEach-Object {
  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $_).Hash.ToLowerInvariant()
  "$hash  $([IO.Path]::GetFileName($_))"
}
[IO.File]::WriteAllLines((Join-Path $release "SHA256SUMS.txt"), $checksums)

Write-Host "Windows release artifacts written to $release"
