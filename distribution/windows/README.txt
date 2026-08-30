MATRIX CODE FOR WINDOWS X64

Installed distribution
  1. Extract Matrix-Code-Windows-x64.zip.
  2. Run: powershell -ExecutionPolicy Bypass -File .\install.ps1
  3. Open a new terminal and run: matrix

Portable distribution (USB drive / no installation)
  1. Extract Matrix-Code-Windows-x64-Portable.zip to any folder or USB drive.
  2. Run matrix.cmd. Configuration, data and cache stay under .matrix\ next to it.
  3. For a personal session that does not store the OmniRoute key on disk, run:
     powershell -ExecutionPolicy Bypass -File .\matrix-personal.ps1

OmniRoute gateway (optional)
  If you place a portable OmniRoute in omniroute\omniroute.exe next to matrix.cmd,
  the launcher will start it automatically when needed and stop it on exit.
  If OmniRoute is already running, the launcher reuses it.
  If OmniRoute is not available, Matrix Code starts normally and prompts for
  an AI provider on first use.

Matrix Voice
  F8 starts recording. F8 again stops and transcribes. The text is inserted into
  the prompt and is not sent. Edit it if needed, then press Enter to send.

AI setup
  On first run choose OmniRoute (recommended) or connect one external provider.
  Free tiers are subject to provider quotas, fair-use rules and availability.
  Matrix Code does not include private credentials or promise unlimited tokens.

Security
  Do not place private keys in the public ZIP. The personal launcher keeps the
  OmniRoute key in process memory for that run and does not write it to disk.

Matrix Code is built on OpenCode, which is licensed under the MIT license.
Full documentation, source, license text and upstream attribution are in the
Matrix Code GitHub repository.
