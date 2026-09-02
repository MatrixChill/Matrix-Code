# OmniRoute auto-start — diagnosis & fix design

> **Status: DIAGNOSIS COMPLETE. Fix is designed; a small isolated patch is safe to prepare.**

## 1. Observed problem

Matrix uses an OmniRoute route, but `localhost:20128` is offline and the app reports
`Cannot connect to API`. When OmniRoute is started **manually**, `/v1/models` returns
HTTP 200 and everything works.

## 2. The two paths — why one auto-starts and the other does not

There are two distinct delivery paths with **different** OmniRoute handling:

### A. Portable (`matrix.cmd`) — HAS auto-start
`distribution/windows/matrix.cmd`:

- sets `MATRIX_PORTABLE_ROOT`, `XDG_*` and `OPENCODE_CONFIG_DIR` to `.matrix\`
- **auto-starts** a bundled local `omniroute\omniroute.exe` when present
- reuses an already-running OmniRoute
- stops it on exit if it started it
- if OmniRoute is unavailable, Matrix starts normally and prompts for a provider

This is why "auto-start works in the Portable": the **launcher** owns the lifecycle of a
co-located gateway and health-checks `localhost:20128` before/while running.

### B. Installed (`install.ps1`) — DOES NOT auto-start
The installed (non-portable) distribution contains only `matrix.exe`, `matrix-voice`,
`LICENSE`, `README.txt` and `install.ps1`. It does **not** ship `matrix.cmd` (the launcher).
`install.ps1` installs `matrix.exe` and adds it to PATH; there is **no launcher that
starts OmniRoute**. `matrix.exe` itself only does the first-run provider setup dialog
(`packages/tui/src/component/dialog-provider.tsx`, `OmniRouteSetup`), which **health-checks
the endpoint with a 3.5s timeout but does not start** OmniRoute.

## 3. Root cause (one line)

The **installed** Matrix has no launcher equivalent to `matrix.cmd`, so it has nothing to
auto-start an OmniRoute gateway; the first-run dialog only checks, never starts, the
endpoint — so with OmniRoute stopped, `localhost:20128` stays offline and the app
reports `Cannot connect to API`.

## 4. Diagnostic flow (confirmed)

- Matrix needs OmniRoute.
- Health check `localhost:20128` (the dialog does `GET {endpoint}/models` with 3.5s timeout;
  `GET /v1/models` returns 200 when running).
- Offline → (portable: launcher starts `omniroute\omniroute.exe`) vs (installed:
  **nothing starts it**).
- Installed Matrix continues to first-run provider setup; if the endpoint is offline it
  shows "OmniRoute is unreachable" and cannot connect.

## 5. Designed fix

Add the same auto-start behaviour the portable launcher has, into the installed path:

```
Matrix needs OmniRoute
        |
        v
health check localhost:20128
        |
        +-- online  --> continue
        |
        +-- offline --> start OmniRoute
        |                 |
        |                 v
        |          wait for readiness (poll /v1/models until 200, bounded)
        |                 |
        |                 v
        |          continue
        |
        v
(if no OmniRoute available) start normally and prompt for provider
```

### Implementation options (safe, small, isolated)

1. **Preferred**: ship a `matrix.cmd`-style launcher with the installed distribution, or
   teach `matrix.exe` to auto-start a co-located/reachably-configured OmniRoute binary
   with the same health-check + readiness logic the Portable uses. This unifies the two
   paths so behaviour is identical.
2. **Alternative**: extend the first-run `OmniRouteSetup` dialog to optionally **start**
   the configured gateway and wait for readiness, rather than only reporting
   unreachable.

### Non-goals for this phase

- No provider fallback routing yet (that is the Model Router / Reliability phase).
- No network service exposure.
- This patch can be prepared if it stays small, isolated and safe; it is not required to
  be merged now.

`/matrix-status` (Matrix Doctor) will surface OmniRoute health so this failure mode is
visible instead of a bare `Cannot connect to API` toast.
