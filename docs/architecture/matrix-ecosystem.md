# Matrix Ecosystem

This document is the single source of truth for the Matrix Code project architecture. It
describes the conceptual layout of the three products that share one core, the boundaries
between them, and the security constraints that apply to each.

> **Status: FOUNDATION (design only).** This phase establishes structure, interfaces and
> contracts. Nothing here is implemented end-to-end yet. No secrets, no heavy builds, no
> release, no push.

## 1. The single-core principle

The whole point of the architecture is that there are **not** three independent forks of the
same code. There is one `MATRIX CORE`, and three ways of delivering it:

```
MATRIX CORE
   |
   +-- MATRIX CODE PUBLIC
   |
   +-- MATRIX PERSONAL
           |
           +-- MATRIX PORTABLE PERSONAL
```

- **MATRIX CODE PUBLIC** is the base shared with anyone. It ships the terminal product
  (TUI), Matrix Voice, localization (PT-BR / PT-PT / EN) and an optional OmniRoute gateway
  integration. It is secret-free.
- **MATRIX PERSONAL** is a private layer **on top of** the Public. It adds personal agents,
  skills, instructions, themes, configurations, Magic Context, memory, and future
  Personal-only features (HUD, advanced voice, automations).
- **MATRIX PORTABLE PERSONAL** is an **artefact generated from** the Personal (not a fork).
  It is the owner's USB copy and contains zero plain-text credentials.

## 2. Conceptual data flow

```
Public (main/dev)   -->  source of the shared Core + TUI + Voice + localization
        |
        v
Personal (personal-dev)  -->  adds personal/ layer; references Public as upstream
        |
        v
Portable Personal  -->  build-time materialization from Personal onto a USB drive
```

The Personal repo keeps the Public as a git remote (`upstream`). Core updates are pulled
down and merged; the `personal/` layer is never overwritten by those updates.

## 3. What lives where

| Concern | Public | Personal | Portable Personal |
|---|---|---|---|
| TUI / terminal | yes | yes (inherited) | yes |
| Matrix Voice (F8) | yes | yes | yes |
| Localization en/pt-pt/pt-BR | yes | yes | yes |
| OmniRoute integration | yes (optional) | yes | yes |
| Providers / agents / skills / MCP | yes (defaults) | yes + personal | yes + personal |
| Magic Context plugin | — (not vendored here) | yes | yes |
| Personal agents / skills | no | **yes** | yes |
| Instructions / themes | defaults | default + personal | personal |
| Personal memory | no | **yes** | yes |
| HUD / advanced voice / automations | no | **future** | future |
| Credentials | **never** | in `personal/` (gitignored) | **never in plain text** |

## 4. Security invariants

1. The **Public** archive (both ZIPs) must contain zero private credentials: no `.matrix`,
   no `auth.json`, no `OMNIROUTE_API_KEY`, no personal configurations.
2. Matrix Code **does not promise infinite tokens.** Free tiers carry provider quotas,
   fair-use rules and availability limits (see `README.md`).
3. `matrix-personal.ps1` keeps the OmniRoute key **in process memory** only (`Read-Host
   -AsSecureString`) and clears it in a `finally` block. It never writes the key to disk.
4. Personal key material is read from environment variables
   (`OMNIROUTE_API_KEY` / `OMNIROUTE_BASE_URL`) and never hard-coded.
5. The **Portable Personal** pendrive is the owner's own device and is **not** the public
   "Portable" artefact. It must still never contain plain-text keys.

## 5. Repository / branch model (planned)

- **Public** repo `Matrix-Code` (existing, public): branches `main`, `dev`, `feature/*`.
  `dev` is the default. Squash commits before merging feature branches into `main`.
- **Personal** repo `Matrix-Personal` (private): branches `main`, `personal-dev`.
  It adds `upstream = Matrix-Code` and a `personal/` layer that is preserved on core updates.

No destructive remote operations happen in this phase. No private repo or publication is
created now.

## 6. Documents in this directory

- `matrix-ecosystem.md` — this overview.
- `public-personal-portable.md` — the three-layer split detail.
- `security-boundaries.md` — secrets and boundaries per layer.
- `model-router.md` — profile-based model selection, metadata, fallback.
- `omniroute-autostart.md` — OmniRoute health-check + auto-start diagnosis and fix design.
- `portable-personal.md` — the USB artefact design, build and update strategy.
- `roadmap.md` — phased evolution of the whole ecosystem.
