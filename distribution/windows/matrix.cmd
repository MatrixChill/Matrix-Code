@echo off
setlocal enabledelayedexpansion
set "MATRIX_PORTABLE_ROOT=%~dp0"
set "XDG_CONFIG_HOME=%~dp0.matrix\config"
set "XDG_DATA_HOME=%~dp0.matrix\data"
set "XDG_CACHE_HOME=%~dp0.matrix\cache"
set "XDG_STATE_HOME=%~dp0.matrix\state"
set "OPENCODE_CONFIG_DIR=%~dp0.matrix\config\opencode"
set "MATRIX_VOICE_HELPER=%~dp0matrix-voice\matrix-voice-helper.exe"
set "MATRIX_VOICE_MODEL_DIR=%~dp0matrix-voice\model"

if not exist "%OPENCODE_CONFIG_DIR%" mkdir "%OPENCODE_CONFIG_DIR%"
if not exist "%XDG_DATA_HOME%" mkdir "%XDG_DATA_HOME%"
if not exist "%XDG_CACHE_HOME%" mkdir "%XDG_CACHE_HOME%"
if not exist "%XDG_STATE_HOME%" mkdir "%XDG_STATE_HOME%"

rem --- OmniRoute auto-start ---
rem Check if OmniRoute is already listening
set "OMNIROUTE_STARTED="
curl -sf -o nul -m 1 http://localhost:20128/v1/models >nul 2>&1
if %ERRORLEVEL% equ 0 goto :run_matrix

rem Try to start a local OmniRoute if present
set "OMNIROUTE_EXE=%~dp0omniroute\omniroute.exe"
if not exist "%OMNIROUTE_EXE%" goto :run_matrix

echo Starting OmniRoute gateway...
start "" /B "%OMNIROUTE_EXE%" >nul 2>&1
set "OMNIROUTE_STARTED=1"

rem Wait up to 15 seconds for API readiness
for /L %%i in (1,1,30) do (
    timeout /t 1 /nobreak >nul 2>&1
    curl -sf -o nul -m 1 http://localhost:20128/v1/models >nul 2>&1
    if !ERRORLEVEL! equ 0 goto :run_matrix
)
echo Warning: OmniRoute did not become ready in time. Starting Matrix Code anyway.

:run_matrix
"%~dp0matrix.exe" %*
set "MATRIX_EXIT=%ERRORLEVEL%"

rem Clean up OmniRoute if we started it
if defined OMNIROUTE_STARTED (
    taskkill /F /IM omniroute.exe >nul 2>&1
)

exit /b %MATRIX_EXIT%
