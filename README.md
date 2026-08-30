# Matrix Code

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.pt-PT.md">Português (Portugal)</a> |
  <a href="README.pt-BR.md">Português (Brasil)</a>
</p>

Matrix Code is a complete terminal coding application built on OpenCode. It keeps the mature TUI, provider ecosystem, model IDs, configuration files, commands, agents, skills and MCP compatibility while adding Matrix branding, EN/pt-PT/pt-BR localization, Matrix Voice and an optional OmniRoute coding preset.

This v1 deliberately focuses on the terminal application. It does not add a new desktop GUI.

## Install on Windows x64

Download the assets from [GitHub Releases](https://github.com/MatrixChill/Matrix-Code/releases/latest). Releases contain compiled binaries; large Voice runtimes and models are not stored in Git.

### Installed edition

1. Download `Matrix-Code-Windows-x64.zip` and extract it.
2. In PowerShell, run:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install.ps1
   ```

3. Open a new terminal and run `matrix`.

The installer copies the application to `%LOCALAPPDATA%\Matrix Code` and adds that directory to the current user's `PATH`. It does not install or copy credentials.

### Portable edition

1. Download `Matrix-Code-Windows-x64-Portable.zip` and extract it to a normal folder or USB drive.
2. Run `matrix.cmd`.

The portable launcher stores configuration, sessions, state and cache under the extracted `.matrix` directory. It discovers the executable, Voice helper and model relative to its own folder. It does not require globally installed Bun, Node.js or Python.

`opencode.cmd` is included as a compatibility entry point. Existing `OPENCODE_*` variables, `opencode.json`, `.opencode`, provider/model IDs and slash commands remain supported.

## First run and AI providers

On first run Matrix Code opens **Matrix Code AI Setup** through the provider dialog. You can start with one provider and add others later with `/connect`:

- **OmniRoute** — recommended gateway for Matrix Free Coding and automatic fallback;
- Qwen/Alibaba and Qoder/iFlow coding access;
- Kimi coding/reasoning;
- NVIDIA NIM, Cerebras and Groq free tiers;
- Cloudflare Workers AI;
- OpenRouter `:free` models;
- DeepSeek or any other supported OpenCode provider.

OAuth, device authorization, API keys, quotas and terms belong to the external provider. You do not need to connect every provider.

## OmniRoute and Matrix Free Coding

Matrix Code uses the existing OpenAI-compatible provider implementation. Enter any configurable OmniRoute endpoint, with `http://localhost:20128/v1` as the local default. If the endpoint cannot be reached during setup, Matrix Code saves the configuration but shows an actionable warning instead of silently failing.

The **Matrix Free Coding** model maps to OmniRoute's `auto/coding` route. OmniRoute owns provider health, quota awareness, retries, circuit breakers and fallback. Matrix Code does not duplicate that routing logic. `Matrix Auto` (`auto`) and `Matrix Fast` (`auto/fast`) are also available, and the normal model dialog still allows manual provider/model selection.

A useful free coding pool prioritizes a small set of connected coding providers: Qwen/Qoder, Kimi, DeepSeek, NVIDIA NIM, Cerebras, Groq, Cloudflare Workers AI and OpenRouter free models. Availability changes by provider and region. “Free” and “unlimited” offers can still have rate limits, fair-use rules, quotas and changing terms; Matrix Code does not promise infinite tokens.

An environment-based template is included at `distribution/windows/templates/opencode.omniroute.jsonc`. It contains no secret.

## Credentials and portable security

Public archives contain zero private credentials. Never commit or publish `.matrix`, `auth.json`, private environment files or a customized archive.

The normal `/connect` flow uses OpenCode's existing credential store. In portable mode that store is inside the local `.matrix` directory, so treat the drive as sensitive.

For a personal portable run without storing an OmniRoute key, use:

```powershell
powershell -ExecutionPolicy Bypass -File .\matrix-personal.ps1
```

The launcher asks for the key as secure input, exposes it only to that Matrix Code process and clears it afterwards. It writes only the secret-free provider template. For team or unattended use, prefer an authenticated OmniRoute endpoint and an operating-system or enterprise secret manager.

## Matrix Voice

Press `F8` once to start recording and `F8` again to stop and transcribe. The recognized text is inserted into the current prompt. It is **not submitted automatically**: edit or combine it with typed text, then press Enter to send.

Windows releases bundle a PyInstaller-built Voice helper, its Python runtime, native audio dependencies and a local faster-whisper model. Python is a build-time dependency only; end users do not install it. The source helper remains usable for development through `MATRIX_VOICE_HELPER`, `MATRIX_VOICE_MODEL_DIR`, `MATRIX_VOICE_PYTHON` and `MATRIX_VOICE_LANGUAGE`.

Press `F9` to cycle the TUI language between English, Portuguese (Portugal) and Portuguese (Brazil).

## Developer build

Install Bun and repository dependencies, then build the current Windows CLI:

```powershell
bun install
bun run --cwd packages/opencode build --single
```

To build both GitHub Release archives, install Python 3.12 build dependencies and run:

```powershell
python -m pip install -r script/voice/requirements-build.txt
powershell -ExecutionPolicy Bypass -File .\script\build-windows-distribution.ps1
```

Outputs are written under `packages/opencode/dist/matrix-release` and include SHA-256 checksums. The `matrix-windows-release` GitHub Actions workflow builds the same assets and attaches them to tagged GitHub Releases.

## Upstream compatibility and attribution

Matrix Code is based on [OpenCode](https://github.com/anomalyco/opencode) and preserves the upstream MIT license and internal compatibility. Copyright notices and the repository [LICENSE](LICENSE) remain in distributions. Matrix Code branding does not imply ownership of OpenCode or of any external AI provider.
