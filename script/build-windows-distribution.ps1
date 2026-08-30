param(
  [switch]$SkipCliBuild,
  [switch]$SkipVoiceBuild,
  [switch]$SkipVoiceSelfTest
)

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$dist = Join-Path $repo "packages\opencode\dist"
$release = Join-Path $dist "matrix-release"
$voiceBuild = Join-Path $dist "matrix-voice-build"

if (-not $release.StartsWith($repo, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Release path escaped the repository"
}

if (-not $SkipCliBuild) {
  & bun run --cwd (Join-Path $repo "packages\opencode") build --single --skip-install
  if ($LASTEXITCODE -ne 0) { throw "Windows CLI build failed" }
}

$cli = Join-Path $dist "opencode-windows-x64\bin\opencode.exe"
if (-not (Test-Path -LiteralPath $cli)) { throw "Windows x64 CLI binary not found: $cli" }

if (-not $SkipVoiceBuild) {
  if (Test-Path -LiteralPath $voiceBuild) { Remove-Item -LiteralPath $voiceBuild -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $voiceBuild | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $voiceBuild "spec") | Out-Null
  $model = Join-Path $voiceBuild "model"
  & python (Join-Path $repo "script\voice\download-model.py") --output $model
  if ($LASTEXITCODE -ne 0) { throw "Matrix Voice model download failed" }
  $modelCache = Join-Path $model ".cache"
  if (Test-Path -LiteralPath $modelCache) { Remove-Item -LiteralPath $modelCache -Recurse -Force }

  & python -m PyInstaller --noconfirm --clean --onedir --name matrix-voice-helper `
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

Copy-Item -LiteralPath (Join-Path $repo "distribution\windows\install.ps1") -Destination $standard
Copy-Item -LiteralPath (Join-Path $repo "distribution\windows\opencode.cmd") -Destination $standard
Copy-Item -LiteralPath (Join-Path $repo "distribution\windows\matrix.cmd") -Destination $portable
Copy-Item -LiteralPath (Join-Path $repo "distribution\windows\matrix.cmd") -Destination (Join-Path $portable "opencode.cmd")
Copy-Item -LiteralPath (Join-Path $repo "distribution\windows\matrix-personal.ps1") -Destination $portable
Copy-Item -LiteralPath (Join-Path $repo "distribution\windows\templates") -Destination $portable -Recurse

$standardZip = Join-Path $release "Matrix-Code-Windows-x64.zip"
$portableZip = Join-Path $release "Matrix-Code-Windows-x64-Portable.zip"
Compress-Archive -Path (Join-Path $standard "*") -DestinationPath $standardZip -CompressionLevel Optimal
Compress-Archive -Path (Join-Path $portable "*") -DestinationPath $portableZip -CompressionLevel Optimal

& (Join-Path $standard "matrix.exe") --version
if ($LASTEXITCODE -ne 0) { throw "Installed distribution smoke test failed" }
& cmd.exe /d /c (Join-Path $portable "matrix.cmd") --version
if ($LASTEXITCODE -ne 0) { throw "Portable distribution smoke test failed" }

$spaceTest = Join-Path $release "space test portable"
Copy-Item -LiteralPath $portable -Destination $spaceTest -Recurse
& cmd.exe /d /c (Join-Path $spaceTest "matrix.cmd") --version
if ($LASTEXITCODE -ne 0) { throw "Portable distribution path-with-spaces smoke test failed" }
Remove-Item -LiteralPath $spaceTest -Recurse -Force

$checksums = @($standardZip, $portableZip) | ForEach-Object {
  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $_).Hash.ToLowerInvariant()
  "$hash  $([IO.Path]::GetFileName($_))"
}
[IO.File]::WriteAllLines((Join-Path $release "SHA256SUMS.txt"), $checksums)

Write-Host "Windows release artifacts written to $release"
