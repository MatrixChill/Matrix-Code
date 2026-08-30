MATRIX CODE FOR WINDOWS X64

Installed distribution
  1. Extract Matrix-Code-Windows-x64.zip.
  2. Run: powershell -ExecutionPolicy Bypass -File .\install.ps1
  3. Open a new terminal and run: matrix

Portable distribution
  1. Extract Matrix-Code-Windows-x64-Portable.zip to a normal folder or USB drive.
  2. Run matrix.cmd. Its configuration, data and cache stay under .matrix.
  3. For a personal session that does not store the OmniRoute key, run:
     powershell -ExecutionPolicy Bypass -File .\matrix-personal.ps1

Matrix Voice
  F8 starts recording. F8 again stops and transcribes. The text is inserted into
  the prompt and is not sent. Edit it if needed, then press Enter to send.

AI setup
  On first run choose OmniRoute (recommended) or connect one external provider.
  Free tiers are subject to provider quotas, fair-use rules and availability.
  Matrix Code does not include private credentials.

Security
  Do not place private keys in the public ZIP. The personal launcher keeps the
  OmniRoute key in process memory for that run and does not write it to disk.

Full documentation, source, MIT license and upstream attribution are in the
Matrix Code GitHub repository.
