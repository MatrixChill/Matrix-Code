# Roadmap — Matrix Code evolution

> **Status: FOUNDATION.** This is the phased plan. This phase only builds foundation,
> architecture, security and preparation. Everything detailed here is designed, not
> implemented end-to-end.

## Phase gates & git rules

- No `push`, no release, no visibility change, no force-push, no history rewrite.
- No exposure of secrets; no discarding existing work.
- **Worktree preserved** as the top invariant.

## Phase 0 — Foundation (THIS)

- Repository audit (branch, remotes, worktree, files, packages, TUI, Voice, localization,
  OmniRoute, Magic Context, agents, skills, build, portable, scripts, configs, docs, deps).
- Security audit + `.gitignore` hardening.
- Architecture docs under `docs/architecture/`.
- Design-only contracts and interfaces.
- OmniRoute auto-start diagnostic (see `omniroute-autostart.md`).

## Phase 1 — Core stabilization

- Unify the OmniRoute auto-start between installed and portable paths.
- Matrix Doctor `/matrix-status`: Core, Voice, Clipboard, Magic Context, Agents, Skills,
  OmniRoute, Providers, Browser, Git, Vision, Portable mode.
- Matrix Models `/matrix-models`: profile, provider, real model, latency, health,
  tool-call reliability, vision, recent errors, fallback status.

## Phase 2 — Model Router & Reliability

- Profile registry: Smart, Coding Max, Reliable, Fast, Vision, Free, Local.
- Model catalog with static metadata + dynamic health/latency.
- Retry → fallback → circuit breaker with bounded retries.
- Providers: OmniRoute, OpenCode Zen, OpenAI, Anthropic, Google, OpenRouter,
  OpenAI-compatible, local, free, paid.

## Phase 3 — Agents & subagents

- Modes: Code, Plan, Ask, Debug, Review, Architect, Custom.
- Preserve existing agents.
- Subagents (Architect → Frontend/Backend/Database/Test, Reviewer) with worktrees,
  isolation, safe parallel execution, merge.

## Phase 4 — Vision & App Builder

- Matrix Vision: detect image request → route to vision-capable model → return result.
  Cases: screenshots, UI images, assets, auto-organize, logo/interior/exterior, compare.
- App Builder with engines (Matrix Native, v0, templates). v0 optional; no key → Matrix
  still works.

## Phase 5 — Reliability automation

- Self-check flow: IMPLEMENT → BUILD → TEST → LINT → TYPECHECK → BROWSER TEST → REVIEW →
  FIX → RETEST → DONE (never DONE without validation when tests are possible).
- Checkpoints (`matrix checkpoint`) + `/matrix-rollback` (recovery layer, not a Git
  replacement).

## Phase 6 — Browser agent & Voice evolution

- Browser: open localhost → navigate → click → fill → inspect → fix → retest (Playwright).
- Voice: preserve F8; future Personal: faster-whisper, VAD, continuous voice, wake word
  "Matrix", streaming, TTS (Kokoro / XTTS / Piper), barge-in.

## Phase 7 — Personal layers

- HUD mode vs Code mode (Personal only).
- Memory: `.matrix/memory/` (architecture, decisions, preferences, project-context) in
  Public/Person; **personal memory separate in the Personal layer**.
- Permissions: READ/WRITE/EXECUTE/NETWORK/BROWSER/GIT/DELETE/DEPLOY ×
  Safe/Ask/Always Ask/Blocked.
- Portable build + update commands.
- GitHub: private `Matrix-Personal` repo with `upstream = Matrix-Code`; `personal/` layer
  preserved across core merges.
