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
  | "quota_exhausted"
  | "restricted_external_route"
  | "model_not_supported"
  | "payment_required"
  | "upstream_failure"
  | "request_invalid"
  | "authentication"
  | "permanent"

// A 429 whose body names a spent provider/account allowance is not a transient
// rate limit. The real OpenRouter free-account rejection — "Rate limit
// exceeded: free-models-per-day" — is the case this exists for: it arrives as
// an ordinary HTTP 429, so the generic path cooled the single route that
// answered, tried its sibling on the same exhausted account, and only then
// looked at another provider.
//
// Matching stays on explicit allowance wording. A plain rate-limit message, and
// any 429 without one of these phrases, keeps its transient classification and
// its Retry-After handling.
const QUOTA_EXHAUSTION_SIGNALS: readonly string[] = [
  "free-models-per-day",
  "free models per day",
  "daily quota",
  "daily limit",
  "per-day limit",
  "per day limit",
  "quota exceeded",
  "exceeded your current quota",
  "insufficient_quota",
]

// Quota exhaustion is only recognized where the message is the one thing that
// separates it from a transient rate limit: the 429 family. A specific code
// (402 payment_required, 403 authentication, ...) keeps its established
// meaning, so this can never reclassify a structured failure.
function signalsQuotaExhaustion(code: string | undefined, normalized: string): boolean {
  if (code !== undefined && code !== "429") return false
  return QUOTA_EXHAUSTION_SIGNALS.some((signal) => normalized.includes(signal))
}

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
  // A spent allowance is not permanent: another provider can serve the request,
  // so it must reach the fallback path instead of stopping the request.
  if (signalsQuotaExhaustion(code, normalized)) return "retry"
  return "none"
}

export function classifyFailure(code: string | undefined, text: string): FailureDisposition {
  const normalized = text.toLowerCase()
  if (
    (code === "403" || code === "400" || code === undefined) &&
    normalized.includes("opencode") &&
    normalized.includes("free tier")
  )
    return "restricted_external_route"
  // Checked before the generic rate-limit branch: a spent allowance is not a
  // transient 429. `quota_exhausted` is what lets the executor scope the
  // failure to the provider credential instead of the one route that answered.
  if (signalsQuotaExhaustion(code, normalized)) return "quota_exhausted"
  if (code === "429" || normalized.includes("rate limit")) return "rate_limit"
  if (
    (code === "400" || code === "401" || code === "404") &&
    (normalized.includes("model not supported") ||
      normalized.includes("model is not supported") ||
      normalized.includes("unsupported model") ||
      normalized.includes("unknown model") ||
      normalized.includes("model_not_found") ||
      // Gateways answer a 400 when a route's model is temporarily unavailable.
      // It is a route availability failure, not a malformed request, so Reliable
      // may try another eligible candidate. Matching stays on the model itself:
      // every other 400 keeps classifying as request_invalid.
      normalized.includes("model is unavailable") ||
      normalized.includes("model unavailable"))
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
  // A spent allowance cools the route that answered and nothing else. It is not
  // an infrastructure outage — sibling backends are unaffected — and not an
  // invalid credential. The provider-wide half is tracked by the executor's own
  // credential-scoped quota state, which never touches router health.
  if (disposition === "quota_exhausted") return "route"
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
