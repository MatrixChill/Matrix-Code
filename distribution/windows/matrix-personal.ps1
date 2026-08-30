$ErrorActionPreference = "Stop"

$root = $PSScriptRoot
$env:MATRIX_PORTABLE_ROOT = $root
$env:XDG_CONFIG_HOME = Join-Path $root ".matrix\config"
$env:XDG_DATA_HOME = Join-Path $root ".matrix\data"
$env:XDG_CACHE_HOME = Join-Path $root ".matrix\cache"
$env:XDG_STATE_HOME = Join-Path $root ".matrix\state"
$env:OPENCODE_CONFIG_DIR = Join-Path $env:XDG_CONFIG_HOME "opencode"
$env:MATRIX_VOICE_HELPER = Join-Path $root "matrix-voice\matrix-voice-helper.exe"
$env:MATRIX_VOICE_MODEL_DIR = Join-Path $root "matrix-voice\model"

New-Item -ItemType Directory -Force -Path $env:OPENCODE_CONFIG_DIR | Out-Null
New-Item -ItemType Directory -Force -Path $env:XDG_DATA_HOME | Out-Null
New-Item -ItemType Directory -Force -Path $env:XDG_CACHE_HOME | Out-Null
New-Item -ItemType Directory -Force -Path $env:XDG_STATE_HOME | Out-Null

$config = Join-Path $env:OPENCODE_CONFIG_DIR "opencode.jsonc"
if (-not (Test-Path -LiteralPath $config)) {
  Copy-Item -LiteralPath (Join-Path $root "templates\opencode.omniroute.jsonc") -Destination $config
}

$endpoint = Read-Host "OmniRoute endpoint [http://localhost:20128/v1]"
$env:OMNIROUTE_BASE_URL = if ($endpoint) { $endpoint.TrimEnd("/") } else { "http://localhost:20128/v1" }
$secret = Read-Host "OmniRoute API key (leave blank only for an unsecured local gateway)" -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)

try {
  $env:OMNIROUTE_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  & (Join-Path $root "matrix.exe") @args
  exit $LASTEXITCODE
}
finally {
  $env:OMNIROUTE_API_KEY = $null
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
}
