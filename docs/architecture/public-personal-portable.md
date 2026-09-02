# Public / Personal / Portable — the three-layer split

> **Status: FOUNDATION (design only).**

This document details how the single Core is delivered as three artefacts without forking
the code, and how updates flow from one layer to the next without losing personal data.

## 1. Layer overview

### 1.1 MATRIX CODE PUBLIC

The distributable product for anyone. It is built from the shared Core repository and is
the base that both Personal layers inherit.

Planned capabilities (future):

- TUI Matrix
- Matrix Voice (F8)
- Ctrl+V
- Localization: PT-BR, PT-PT, EN
- OmniRoute gateway integration
- Providers, agents, skills, MCP
- Browser, Git/GitHub
- Matrix Vision, Matrix Doctor, Model Router
- self-check, checkpoints
- App Builder with optional v0 integration

Excluded:

- personal data
- personal memories
- personal credentials and tokens

### 1.2 MATRIX PERSONAL

A private layer on top of the Public. In the future it lives in a separate private GitHub
repo `Matrix-Personal`.

Contains or references:

- the Public/Core (via git remote `upstream`)
- personal agents, skills, instructions, themes
- personal configuration
- Magic Context
- personal memory and project memory
- future: HUD, PC control, automations, advanced voice, TTS, wake word, barge-in,
  local AI, personal tools

Constraint: it must **not** duplicate the whole Core unnecessarily.

### 1.3 MATRIX PORTABLE PERSONAL

The owner's USB artefact, **generated from** the Personal layer. It is NOT the public
Portable. Runs directly from the USB when Windows permits external execution.

Includes: Matrix executable, Voice, Magic Context, personal agents/skills/instructions,
themes, safe plugins, portable configs, Model Router, Doctor, compatible browser/tools,
data under `.matrix/`, and a pendrive README.

Excludes in plain text: all API keys, GitHub/OpenAI/Anthropic/Google/v0/OmniRoute
credentials and passwords.

## 2. Update strategy (Public → Personal)

Goal: the Personal repo receives core updates without losing `personal/`.

```
Matrix-Code (Public, upstream)
        |
        |   git fetch upstream ; git merge upstream/dev
        v
Matrix-Personal (personal-dev)
        |
        +-- personal/            <- preserved, never overwritten by the merge
        +-- core tree            <- updated from upstream
```

Rules:

1. Keep `personal/` as a clearly separated top-level directory.
2. Never edit `personal/` from a Public commit; the Public repo simply has no
   `personal/` subtree in its merge path.
3. Prefer merging core changes on a `core-sync` branch first, then merge into
   `personal-dev` so conflicts surface in isolation.
4. Personal-only dotfiles (`*.private.env`, `credentials.local.json`) stay gitignored and
   on the pendrive, never committed.

## 3. Non-destructive principles (this phase)

- No `reset`, no destructive `checkout`, no force-push, no history rewrite.
- No private repo creation and no publication yet.
- Everything here is structure, documentation, interfaces and contracts.
