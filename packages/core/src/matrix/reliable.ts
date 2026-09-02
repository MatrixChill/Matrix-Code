export * as MatrixReliable from "./reliable"

import { MatrixRouter } from "./router"
import { MatrixProfile } from "./profile"
import { MatrixCatalog } from "./catalog"

// A failure is "recoverable" when a retry or a model/provider fallback is
// reasonable. Prompt/permission/auth errors are permanent and must NOT trigger a
// fallback (the user's input is the issue, not the model).
export type RecoverableKind =
  | "retry" // same request may succeed on retry
  | "fallback" // a different model/provider should take over
  | "none" // permanent; do not fall back

export const RETRY_ERRORS = new Set([
  "429",
  "502",
  "503",
])
export const FALLBACK_ERRORS = new Set([
  "500",
  "504",
])
// Permanent errors that must never trigger a model fallback.
export const PERMANENT_ERRORS = new Set([
  "400",
  "401",
  "403",
  "404",
  "408",
  "422",
])

export function classifyError(code: string | undefined, text: string): RecoverableKind {
  if (code !== undefined && RETRY_ERRORS.has(code)) return "retry"
  if (code !== undefined && FALLBACK_ERRORS.has(code)) return "fallback"
  if (code !== undefined && PERMANENT_ERRORS.has(code)) return "none"
  const normalized = text.toLowerCase()
  if (normalized.includes("upstream request timeout")) return "fallback"
  if (normalized.includes("idle timeout") || normalized.includes("timeout")) return "fallback"
  if (normalized.includes("connection refused")) return "fallback"
  if (normalized.includes("provider offline") || normalized.includes("cannot connect to api"))
    return "fallback"
  if (normalized.includes("rate limit")) return "retry"
  if (normalized.includes("authentication") || normalized.includes("unauthorized"))
    return "none"
  if (normalized.includes("permission")) return "none"
  return "none"
}

export interface FallbackOutcome {
  readonly action: "continue" | "fallback" | "stop"
  // The fallback selection when action === "fallback"
  readonly selection?: MatrixRouter.Selection
}

// Decide what to do after a request failure on the current model.
export function decideFailure(
  code: string | undefined,
  text: string,
  attempt: number,
  maxAttempts: number,
  router: MatrixRouter.Router,
  profile: MatrixProfile.ProfileID,
  candidates: readonly MatrixCatalog.Candidate[],
  isAvailable: MatrixRouter.Available,
): FallbackOutcome {
  const kind = classifyError(code, text)
  // Permanent errors: never fall back.
  if (kind === "none") return { action: "stop" }
  // Bounded retries on the same model first.
  if (kind === "retry") {
    if (attempt < maxAttempts) return { action: "continue" }
    // Retries exhausted: fall back rather than stop, if possible.
    const selection = router.fallback(profile, candidates, isAvailable)
    if (selection === undefined) return { action: "stop" }
    return { action: "fallback", selection }
  }
  // Provider/model-level failure: fall back immediately.
  const selection = router.fallback(profile, candidates, isAvailable)
  if (selection === undefined) return { action: "stop" }
  return { action: "fallback", selection }
}
