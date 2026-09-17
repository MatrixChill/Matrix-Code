export * as MatrixReliable from "./reliable"

import { MatrixRouter } from "./router"
import { MatrixProfile } from "./profile"
import { MatrixCatalog } from "./catalog"
import { MatrixProvider } from "./provider"

// A failure is "recoverable" when a retry or a model/provider fallback is
// reasonable. Prompt/permission/auth errors are permanent and must NOT trigger a
// fallback (the user's input is the issue, not the model).
export type RecoverableKind =
  | "retry" // same request may succeed on retry
  | "fallback" // a different model/provider should take over
  | "none" // permanent; do not fall back

export type FailureDisposition =
  | "rate_limit"
  | "restricted_external_route"
  | "model_not_supported"
  | "payment_required"
  | "upstream_failure"
  | "request_invalid"
  | "authentication"
  | "permanent"

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

export function classifyFailure(code: string | undefined, text: string): FailureDisposition {
  const normalized = text.toLowerCase()
  if (
    code === "403" &&
    normalized.includes("opencode") &&
    normalized.includes("free tier") &&
    normalized.includes("within opencode")
  )
    return "restricted_external_route"
  if (code === "429" || normalized.includes("rate limit")) return "rate_limit"
  if (
    (code === "400" || code === "401" || code === "404") &&
    (normalized.includes("model not supported") ||
      normalized.includes("model is not supported") ||
      normalized.includes("unsupported model") ||
      normalized.includes("unknown model") ||
      normalized.includes("model_not_found"))
  )
    return "model_not_supported"
  if (code === "402") return "payment_required"
  if (code === "400" || code === "408" || code === "422") return "request_invalid"
  if (code === "401" || code === "403") return "authentication"
  if (
    code === "500" ||
    code === "502" ||
    code === "503" ||
    code === "504" ||
    normalized.includes("timeout") ||
    normalized.includes("connection refused") ||
    normalized.includes("provider offline") ||
    normalized.includes("cannot connect to api")
  )
    return "upstream_failure"
  return "permanent"
}

export function failureScope(disposition: FailureDisposition): MatrixProvider.FailureScope {
  if (disposition === "model_not_supported" || disposition === "payment_required" || disposition === "rate_limit")
    return "route"
  if (disposition === "upstream_failure") return "infrastructure"
  if (disposition === "restricted_external_route") return "infrastructure"
  if (disposition === "authentication") return "credential"
  return "request"
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
  _attempt: number,
  _maxAttempts: number,
  router: MatrixRouter.Router,
  profile: MatrixProfile.ProfileID,
  candidates: readonly MatrixCatalog.Candidate[],
  isAvailable: MatrixRouter.Available,
): FallbackOutcome {
  const kind = classifyError(code, text)
  // Permanent errors: never fall back.
  if (kind === "none") return { action: "stop" }
  // Never repeat a failed candidate inside the same request. The caller passes
  // only candidates that have not been attempted yet.
  if (kind === "retry") {
    const selection = router.fallback(profile, candidates, isAvailable)
    if (selection === undefined) return { action: "stop" }
    return { action: "fallback", selection }
  }
  // Provider/model-level failure: fall back immediately.
  const selection = router.fallback(profile, candidates, isAvailable)
  if (selection === undefined) return { action: "stop" }
  return { action: "fallback", selection }
}
