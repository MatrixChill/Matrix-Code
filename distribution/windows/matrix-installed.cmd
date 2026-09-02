@echo off
setlocal enabledelayedexpansion
rem Matrix Code launcher for an INSTALLED distribution (real user config, not portable .matrix).
rem Auto-starts a co-located OmniRoute gateway when localhost:20128 is offline,
rem so installed Matrix has the same reliability as the Portable matrix.cmd.
rem Relocatable: works directly or from a bin\ subfolder next to matrix.exe.

set "MATRIX_EXE=%~dp0matrix.exe"
if not exist "%MATRIX_EXE%" set "MATRIX_EXE=%~dp0..\matrix.exe"
if not exist "%MATRIX_EXE%" (
  echo Matrix Code executable not found next to this launcher.
  echo Run install.ps1 from the distribution directory first.
  exit /b 1
)

rem Voice helper travels with the executable in the installed distribution.
set "MATRIX_VOICE_HELPER=%~dp0matrix-voice\matrix-voice-helper.exe"
if not exist "%MATRIX_VOICE_HELPER%" if exist "%~dp0..\matrix-voice\matrix-voice-helper.exe" (
  set "MATRIX_VOICE_HELPER=%~dp0..\matrix-voice\matrix-voice-helper.exe"
)

rem --- OmniRoute auto-start -----------------------------------------------
rem Only start a gateway if none is already listening, so we never spawn a
rem second instance and never kill an OmniRoute the user opened beforehand.
set "OMNIROUTE_STARTED="
curl -sf -o nul -m 1 http://localhost:20128/v1/models >nul 2>&1
if %ERRORLEVEL% equ 0 goto :run_matrix

set "OMNIROUTE_EXE="
if exist "%~dp0omniroute\omniroute.exe" set "OMNIROUTE_EXE=%~dp0omniroute\omniroute.exe"
if not defined OMNIROUTE_EXE if exist "%~dp0..\omniroute\omniroute.exe" set "OMNIROUTE_EXE=%~dp0..\omniroute\omniroute.exe"
if not defined OMNIROUTE_EXE (
  echo OmniRoute is offline on localhost:20128 and no co-located gateway was found.
  echo Starting Matrix Code anyway; OmniRoute routes may report "Cannot connect to API".
  goto :run_matrix
)

echo Starting OmniRoute gateway...
start "" /B "%OMNIROUTE_EXE%" >nul 2>&1
set "OMNIROUTE_STARTED=1"

rem Wait up to ~15 seconds for API readiness.
for /L %%i in (1,1,30) do (
    timeout /t 1 /nobreak >nul 2>&1
    curl -sf -o nul -m 1 http://localhost:20128/v1/models >nul 2>&1
    if !ERRORLEVEL! equ 0 goto :run_matrix
)
echo Warning: OmniRoute did not become ready in time. Starting Matrix Code anyway.

:run_matrix
"%MATRIX_EXE%" %*
set "MATRIX_EXIT=%ERRORLEVEL%"

rem Clean up OmniRoute ONLY when this launcher started it.
if defined OMNIROUTE_STARTED (
    taskkill /F /IM omniroute.exe >nul 2>&1
)

exit /b %MATRIX_EXIT%
