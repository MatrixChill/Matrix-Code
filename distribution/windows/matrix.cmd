@echo off
setlocal
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

"%~dp0matrix.exe" %*
exit /b %ERRORLEVEL%
