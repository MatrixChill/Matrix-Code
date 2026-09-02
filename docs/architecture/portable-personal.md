# Portable Personal

> **Status: FOUNDATION (design only).**

The **Portable Personal** is the owner's USB artefact, generated from the **Personal**
layer. It is NOT the public Portable distribution.

## 1. Goals

Run directly from the USB when Windows permits external execution, while keeping all data
under `.matrix/` and carrying zero plain-text credentials.

## 2. Contents (future)

- Matrix executable
- Matrix Voice
- Magic Context
- personal agents
- personal skills
- instructions
- themes
- safe plugins
- portable configurations
- Matrix Model Router
- Matrix Doctor
- compatible browser/tools
- data under `.matrix/`
- pendrive README

## 3. Exclusion

No API keys, GitHub/OpenAI/Anthropic/Google/v0/OmniRoute secrets, or passwords in plain
text. Credentials are in-memory (env or secure prompt) only.

## 4. Existing portable foundation (to preserve)

The public `matrix.cmd` / `matrix-personal.ps1` already establish the portable pattern that
Personal inherits:

- `MATRIX_PORTABLE_ROOT = $PSScriptRoot`
- `XDG_CONFIG_HOME/DATA_HOME/CACHE_HOME/STATE_HOME = .matrix\config|data|cache|state`
- `OPENCODE_CONFIG_DIR = .matrix\config\opencode`
- `MATRIX_VOICE_HELPER` / `MATRIX_VOICE_MODEL_DIR`
- OmniRoute auto-start when `omniroute\omniroute.exe` is co-located
- `matrix-personal.ps1` keeps the OmniRoute key in memory only

The Portable-Personal build reuses this exact mechanism.

## 5. Build command (planned)

```
matrix portable build
```
or

```
script/build-personal-portable.ps1
```

Future steps:

1. build Matrix
2. include Voice
3. include Magic Context
4. include agents
5. include skills
6. include instructions
7. include themes
8. include safe plugins
9. **exclude secrets**
10. generate a portable `.matrix`
11. health check
12. README
13. ZIP

## 6. Update command (planned)

```
matrix portable sync <drive>
```
or

```
matrix portable update
```

Updates Core, Voice, Skills, Agents, Themes, Plugins, Scripts, Model Router — **without**
deleting projects, useful cache, personal configs or necessary state.

### Preservation vs update

| Preserve | Update |
|---|---|
| projects | Core |
| useful cache | Voice |
| personal configs | Skills |
| necessary state | Agents, Themes, Plugins, Scripts, Model Router |

## 7. Non-goals this phase

- No heavy build yet.
- No USB execution override.
- No secrets handling beyond existing in-memory pattern.
