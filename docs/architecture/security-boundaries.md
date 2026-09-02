# Security Boundaries

> **Status: FOUNDATION.** This is the reference for where secrets may and may not live.

The hard rule that drives the whole architecture:

> **The Public and Portable-Personal artefacts must contain zero private credentials.**

## 1. Threat model summary

- Public ZIPs are downloadable by anyone. Any committed or packaged credential leaks.
- The Portable-Personal pendrive is a physical device that can be lost. Even though it is
  the owner's device, it must never carry plain-text keys.
- Local config files (`~/.config/opencode/opencode.json`) legitimately contain the real
  OmniRoute key. Those live only on the owner's machine and must never be copied into a
  public artefact.

## 2. What is secret / sensitive

| Class | Examples | Handled by |
|---|---|---|
| Global secrets | OmniRoute `sk-...`, provider API keys, GitHub token | env vars + gitignore, in-memory only |
| Personal config | `opencode.json` with real key | never copied to Public/Portable-Public |
| Personal memory | project/personal memories | never mix into Public |
| Portable state | `.matrix/`, auth, cache, sessions | gitignored, not packaged |

## 3. Per-layer rules

### Public
- `matrix-personal.ps1` in the released ZIP is the **clean** variant: key read via
  `Read-Host -AsSecureString`, held in memory, zeroed in `finally`.
- `templates/opencode.omniroute.jsonc` contains **no key**, only an `env:` reference.
- No `.matrix/`, no `auth.json`, no `OMNIROUTE_API_KEY` literal.

### Personal
- Real config lives on disk locally but is gitignored (`credentials.local.json`,
  `*.private.env`, `**/.matrix/`).
- Personal memory and agents may be stored, but any secrets inside them are gitignored.

### Portable Personal
- All credential inputs at runtime; nothing in plain text.
- Key is read from env (`OMNIROUTE_API_KEY`) or in-memory prompt, never written to the USB.

## 4. `.gitignore` coverage

The root `.gitignore` now includes:

```
.env
.env.*
!.env.example
**/.matrix/
distribution/windows/private/
*.private.env
credentials.local.json
private/
personal/
*.log
gitleaks-report.*
```

> Note: `!.env.example` keeps example files tracked while ignoring real env files.
> `private/` and `personal/` collars the future Personal repo/artefact area listed as
> non-shipping content. Gitignore only affects untracked files, so already-committed logs
> are untouched until deliberately removed.

## 5. Validation checklist

Before any release:

- [ ] `git grep` for `sk-`, `ghp_`, `AKIA`, `Authorization: Bearer`, `xoxb-` returns no
      real values (test fixtures excluded).
- [ ] Public ZIPs contain no `.matrix/` or `auth.json`.
- [ ] Released `matrix-personal.ps1` matches the git source and is the clean variant.
- [ ] Released `opencode.omniroute.jsonc` references key via `env:` only.
- [ ] Matrix executable contains the AI-first-run fix (i18n string
      `omniRouteUnreachableTitle`, "OmniRoute is unreachable").
