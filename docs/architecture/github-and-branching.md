# GitHub & Branching strategy

> **Status: FOUNDATION (design only).** No remote operations happen in this phase.

## 1. Repos

| Repo | Visibility | Purpose |
|---|---|---|
| `Matrix-Code` | **public** (existing) | the shared Core + Public product |
| `Matrix-Personal` | **private** (future) | personal layer on top of Public |

`Matrix-Personal` holds `upstream = Matrix-Code` and a `personal/` layer that is preserved
across core merges.

## 2. Public repo branches

- `dev` — default branch (matches repo default `dev`).
- `main` — stable releases.
- `feature/*` — short-lived branches.

Merge discipline: **squash** feature branches into `main` to keep history clean.

## 3. Personal repo branches

- `main`
- `personal-dev`

## 4. Update flow (Public → Personal)

```
Matrix-Code (upstream)
   |
   git fetch upstream
   |
   v
Matrix-Personal: merge upstream/dev into personal-dev (on a core-sync branch)
   |
   v
       +-- personal/   preserved (never overwritten)
       +-- core tree   updated
```

## 5. Branch naming (repo convention, from AGENTS.md)

Max three words, hyphen-separated, no slashes or type prefixes.

- Good: `session-recovery`, `fix-scroll-state`, `regenerate-sdk`
- Bad: `feat/foo`, `fix/bar`

Commit / PR titles: `type(scope): summary` (`feat` `fix` `docs` `chore` `refactor` `test`).

## 6. Nothing destructive

- No force-push, no history rewrite, no `reset`.
- The private repo is **not created** in this phase.
