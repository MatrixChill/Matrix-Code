MATRIX CODE FOR WINDOWS X64

Installed distribution
  1. Extract Matrix-Code-Windows-x64.zip.
  2. Run: powershell -ExecutionPolicy Bypass -File .\install.ps1
  3. Open a new terminal and run: matrix

Portable distribution (USB drive / no installation)
  1. Extract Matrix-Code-Windows-x64-Portable.zip to any folder or USB drive.
  2. Launch Matrix:
     - matrix.cmd      (CMD launcher, works on most systems)
     - matrix.ps1      (PowerShell launcher, works when cmd.exe is blocked)
  3. For a personal session that does not store the OmniRoute key on disk, run:
     powershell -ExecutionPolicy Bypass -File .\matrix-personal.ps1

  All launchers resolve paths relative to their own location. No hardcoded
  drive letters. Configuration, data and cache stay under .matrix\ next to
  the executable.

Expected portable structure
  Matrix-Code-Portable\
    matrix.exe            Matrix Code executable
    matrix.cmd            CMD launcher (with OmniRoute auto-start)
    matrix.ps1            PowerShell launcher (with OmniRoute auto-start)
    matrix-personal.ps1   Personal launcher (interactive key, memory-only)
    .matrix\              Portable config, data, cache, state
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
  No admin privileges required. No execution policy bypass for security controls.

Matrix Code is built on OpenCode, which is licensed under the MIT license.
Full documentation, source, license text and upstream attribution are in the
Matrix Code GitHub repository.
