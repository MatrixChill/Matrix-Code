@echo off
rem ============================================================================
rem  Matrix Code portable launcher (CMD entry point).
rem
rem  Launches the PowerShell orchestrator (matrix.ps1) invisibly so the desktop
rem  user sees exactly one window: the Matrix Code TUI. OmniRoute (20128) and
rem  the Matrix API (20260) are orchestrated by matrix.ps1 in the background:
rem  started or reused, recuperated from stale PID files, readied, and on close
rem  stopped only when this launcher started them. The API key survives in
rem  .matrix\state\matrix-api.cred, so 20260 comes back online on reopen.
rem
rem  No execution-policy flags are used and the machine policy is never
rem  changed; local scripts run under the policy the administrator configured
rem  (RemoteSigned or friendlier). No admin rights are required.
rem ============================================================================

set "MATRIX_PS1=%~dp0matrix.ps1"
if not exist "%MATRIX_PS1%" (
  echo Matrix Code PowerShell launcher not found next to this launcher.
  exit /b 1
)

powershell.exe -NoProfile -WindowStyle Hidden -File "%MATRIX_PS1%" %*
exit /b %ERRORLEVEL%