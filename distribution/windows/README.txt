MATRIX CODE FOR WINDOWS X64

Installed distribution
  1. Extract Matrix-Code-Windows-x64.zip.
  2. Run: powershell -File .\install.ps1
  3. Open a new terminal and run: matrix

Portable distribution (USB drive / no installation)
  1. Extract Matrix-Code-Windows-x64-Portable.zip to any folder or USB drive.
  2. Launch Matrix:
     - matrix.cmd      (CMD launcher, delegates to matrix.ps1)
     - matrix.ps1      (PowerShell launcher, works when cmd.exe is blocked)
  3. For a personal session that does not store the OmniRoute key on disk, run:
     powershell -File .\matrix-personal.ps1

  All launchers resolve paths relative to their own location. No hardcoded
  drive letters. Configuration, data and cache stay under .matrix\ next to
  the executable.

  The launcher runs invisibly: the only window you see is Matrix Code itself.
  OmniRoute and the Matrix API run in the background and are stopped again on
  close only when the launcher started them. No execution-policy flags are
  used and the machine policy is never changed (a RemoteSigned or friendlier
  local policy is all that is needed). No admin privileges are required.

Expected portable structure
  Matrix-Code-Portable\
    matrix.exe            Matrix Code executable
    matrix.cmd            CMD launcher (delegates to matrix.ps1)
    matrix.ps1            PowerShell launcher (owns OmniRoute + Matrix API)
    matrix-personal.ps1   Personal launcher (interactive key, memory-only)
    .matrix\              Portable config, data, cache, state
      state\              Secure per-user Matrix API key store (encrypted)
    matrix-voice\         Matrix Voice helper and model
    omniroute\            (optional) Bundled OmniRoute gateway
      node.exe            (optional) Bundled Node.js runtime
      app\bin\omniroute.mjs  (optional) OmniRoute Node entry point
      omniroute.exe       (optional) Standalone OmniRoute binary
    templates\            Configuration templates

OmniRoute gateway (optional)
  OmniRoute provides multi-model AI routing. It is optional — Matrix Code
  works without it and will prompt for an AI provider on first use.

  The launcher auto-starts OmniRoute if it is available locally:
    - omniroute\omniroute.exe     (standalone binary)
    - omniroute\node.exe + omniroute\app\bin\omniroute.mjs  (bundled Node)

  The launcher checks localhost:20128 before starting anything. If OmniRoute
  is already running, the launcher reuses it. If not available, Matrix Code
  starts normally with a warning.

  OmniRoute may be prepared on a trusted machine and copied to the USB.
  No npm install is required at runtime. No global Node dependency needed.

  The launcher only cleans up an OmniRoute process it started itself.
  Pre-existing OmniRoute processes are never killed.

  Environment variables (set before launching Matrix):
    OMNIROUTE_API_KEY      API key for the OmniRoute gateway
    OMNIROUTE_BASE_URL     Gateway URL (default: http://localhost:20128/v1)

Matrix API (local, always available on reopen)
  Matrix Code ships a local OpenAI-compatible API on port 20260. The launcher
  starts it automatically and restores it every time Matrix Code is opened
  again, even after a previous session was closed. Behaviours:

    - First run: if no key exists yet, a strong random key is generated once
      and stored encrypted (DPAPI, current user only) in
      .matrix\state\matrix-api.cred. You are never asked again.
    - To use your own key instead, set MATRIX_API_KEY before the first launch;
      it is persisted once and reused afterwards. Set MATRIX_API_ENABLED=false
      to disable the local API entirely (fail closed).
    - Each launch: an existing listener on port 20260 is reused; otherwise the
      API is started and probed until ready. Stale .matrix\*.pid files never
      block a restart. The key is never printed, logged, or passed on a
      command line, and only processes the launcher started are stopped.

  Environment variables (set before launching Matrix):
    MATRIX_API_ENABLED     true/false (default: enabled once a key exists)
    MATRIX_API_KEY         Bearer token for the local API (persisted once)
    MATRIX_API_PORT        Port override (default: 20260)

Matrix Voice
  F8 starts recording. F8 again stops and transcribes. The text is inserted
  into the prompt and is not sent. Edit it if needed, then press Enter to send.

AI setup
  On first run choose OmniRoute (recommended) or connect one external provider.
  Free tiers are subject to provider quotas, fair-use rules and availability.
  Matrix Code does not include private credentials or promise unlimited tokens.

Security
  Do not place private keys in the public ZIP. The personal launcher keeps the
  OmniRoute key in process memory for that run and does not write it to disk.
  The Matrix API key is stored encrypted (DPAPI, current Windows user only)
  under .matrix\state\matrix-api.cred when necessary and is never echoed or
  logged. No admin privileges required. The launchers never change the
  execution policy and never pass execution-policy flags.

Matrix Code is built on OpenCode, which is licensed under the MIT license.
Full documentation, source, license text and upstream attribution are in the
Matrix Code GitHub repository.
