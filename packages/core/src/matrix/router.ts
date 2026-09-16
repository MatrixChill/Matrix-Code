export * as MatrixRouter from "./router"

import { MatrixCatalog } from "./catalog"
import { MatrixProfile, WEIGHTS } from "./profile"
import { MatrixProvider } from "./provider"

// Last recorded error for a candidate, used to surface provider failures in the
// routing status without duplicating the message into a separate tracking store.
export interface CandidateError {
  readonly message: string
  // Provider/business error code, e.g. "429" or "insufficient_quota".
  readonly code?: string
  // HTTP status code when the gateway answered the request.
  readonly status?: number
  // ms epoch when the failure was recorded.
  readonly at: number
}

// Runtime health for a candidate, tracked by the router instance.
export interface CandidateState {
  // 1.0 = healthy, decreasing with recent failures
  health: number
  // ms epoch when the candidate may be tried again; 0 = no cooldown
  cooldownUntil: number
  recentFailures: number
  successes: number
  failures: number
  // Exponential moving average of successful time-to-first-response.
  latencyMs?: number
  // Session/process-scoped removal for terminal candidate failures.
  disabledReason?: "model_not_supported" | "payment_required"
  // Most recent recorded failure, when the request error was surfaced.
  lastError?: CandidateError
}

export interface InfrastructureState {
  health: number
  cooldownUntil: number
  recentFailures: number
  successes: number
  failures: number
  lastError?: CandidateError
}

export interface Selection {
  readonly candidate: MatrixCatalog.Candidate
  readonly rank: number
  readonly profile: MatrixProfile.ProfileID
}

// Predicate: true when the provider is configured and the model is expected to work.
export type Available = (candidate: MatrixCatalog.Candidate) => boolean

const freshState: CandidateState = {
  health: 1,
  cooldownUntil: 0,
  recentFailures: 0,
  successes: 0,
  failures: 0,
}

const freshInfrastructureState: InfrastructureState = {
  health: 1,
  cooldownUntil: 0,
  recentFailures: 0,
  successes: 0,
  failures: 0,
}

// Score a candidate for a profile. Higher is better; -1 means not usable.
export function score(candidate: MatrixCatalog.Candidate, profile: MatrixProfile.ProfileID): number {
  const w = WEIGHTS[profile]
  if (!MatrixCatalog.supportsProfile(candidate, profile)) return -1
  let total = 0
  total += candidate.coding * w.coding
  total += candidate.reasoning * w.reasoning
  total += candidate.speed * w.speed
  total += candidate.toolCalls * w.toolCalls
  if (profile === "vision") {
    total += (candidate.vision ? 1 : 0) * w.vision
  } else {
    total += w.vision
  }
  // invert cost: cheaper is better, weighted
  total += (5 - candidate.cost) * w.cost
  return total
}

export class Router {
  private readonly states = new Map<string, CandidateState>()
  private readonly infrastructureStates = new Map<string, InfrastructureState>()
  private readonly preferred = new Map<MatrixProfile.ProfileID, string>()

  constructor(private readonly now: () => number = () => Date.now()) {}

  private isCoolingDown(candidate: MatrixCatalog.Candidate): boolean {
    const state = this.states.get(candidate.id)
    return state !== undefined && state.cooldownUntil > this.now()
  }

  private isEnabled(candidate: MatrixCatalog.Candidate): boolean {
    return this.states.get(candidate.id)?.disabledReason === undefined
  }

  private rank(candidate: MatrixCatalog.Candidate, profile: MatrixProfile.ProfileID): number {
    const routeHealth = this.states.get(candidate.id)?.health ?? 1
    const infrastructureHealth = this.infrastructureHealth(candidate)
    return score(candidate, profile) + (routeHealth - 1) * 2 + (infrastructureHealth - 1)
  }

  // Best available candidate for a profile; undefined when none usable.
  select(
    profile: MatrixProfile.ProfileID,
    candidates: readonly MatrixCatalog.Candidate[],
    isAvailable: Available,
  ): Selection | undefined {
    const eligible = candidates
      .filter((candidate) => MatrixCatalog.supportsProfile(candidate, profile))
      .filter(isAvailable)
      .filter((candidate) => !this.isCoolingDown(candidate))
      .filter((candidate) => this.isEnabled(candidate))
    const preferred = this.preferred.get(profile)
    const sticky = eligible.find((candidate) => candidate.id === preferred)
    if (sticky !== undefined && this.infrastructureHealth(sticky) === 1)
      return { candidate: sticky, rank: this.rank(sticky, profile), profile }
    const ranked = eligible
      .sort((a, b) => this.rank(b, profile) - this.rank(a, profile))
    const top = ranked[0]
    if (top === undefined) return undefined
    return { candidate: top, rank: this.rank(top, profile), profile }
  }

  // Fallback uses the same circuit state as initial selection. A cooling or
  // disabled candidate must not re-enter the same or a later request.
  fallback(
    profile: MatrixProfile.ProfileID,
    candidates: readonly MatrixCatalog.Candidate[],
    isAvailable: Available,
  ): Selection | undefined {
    const eligible = candidates
      .filter((candidate) => MatrixCatalog.supportsProfile(candidate, profile))
      .filter(isAvailable)
      .filter((candidate) => !this.isCoolingDown(candidate))
      .filter((candidate) => this.isEnabled(candidate))
      .sort((a, b) => {
        const diversity = this.infrastructureHealth(b) - this.infrastructureHealth(a)
        return diversity === 0 ? this.rank(b, profile) - this.rank(a, profile) : diversity
      })
    const top = eligible[0]
    if (top === undefined) return undefined
    return { candidate: top, rank: this.rank(top, profile), profile }
  }

  recordFailure(
    candidate: MatrixCatalog.Candidate,
    cooldownMs: number,
    error?: Omit<CandidateError, "at">,
    scope: MatrixProvider.FailureScope = failureScope(error),
  ): void {
    if (scope === "credential" || scope === "request") return
    const current = this.states.get(candidate.id) ?? freshState
    this.states.set(candidate.id, {
      health: Math.max(0, current.health - 0.25),
      cooldownUntil: this.now() + cooldownMs,
      recentFailures: current.recentFailures + 1,
      successes: current.successes,
      failures: current.failures + 1,
      ...(current.latencyMs === undefined ? {} : { latencyMs: current.latencyMs }),
      ...(current.disabledReason === undefined ? {} : { disabledReason: current.disabledReason }),
      ...(error === undefined ? {} : { lastError: { ...error, at: this.now() } }),
    })
    if (scope !== "infrastructure") return
    const infrastructureId = MatrixCatalog.infrastructureId(candidate)
    const infrastructure = this.infrastructureStates.get(infrastructureId) ?? freshInfrastructureState
    this.infrastructureStates.set(infrastructureId, {
      health: Math.max(0, infrastructure.health - 0.25),
      cooldownUntil: this.now() + cooldownMs,
      recentFailures: infrastructure.recentFailures + 1,
      successes: infrastructure.successes,
      failures: infrastructure.failures + 1,
      ...(error === undefined ? {} : { lastError: { ...error, at: this.now() } }),
    })
  }

  disable(
    candidate: MatrixCatalog.Candidate,
    reason: NonNullable<CandidateState["disabledReason"]>,
    error?: Omit<CandidateError, "at">,
  ): void {
    const current = this.states.get(candidate.id) ?? freshState
    this.states.set(candidate.id, {
      ...current,
      health: 0,
      cooldownUntil: Number.POSITIVE_INFINITY,
      recentFailures: current.recentFailures + 1,
      failures: current.failures + 1,
      disabledReason: reason,
      ...(error === undefined ? {} : { lastError: { ...error, at: this.now() } }),
    })
    for (const [profile, id] of this.preferred) {
      if (id === candidate.id) this.preferred.delete(profile)
    }
  }

  recordSuccess(
    candidate: MatrixCatalog.Candidate,
    profile?: MatrixProfile.ProfileID,
    latencyMs?: number,
  ): void {
    const current = this.states.get(candidate.id) ?? freshState
    this.states.set(candidate.id, {
      health: Math.min(1, current.health + 0.1),
      cooldownUntil: 0,
      recentFailures: 0,
      successes: current.successes + 1,
      failures: current.failures,
      ...(latencyMs === undefined
        ? current.latencyMs === undefined
          ? {}
          : { latencyMs: current.latencyMs }
        : { latencyMs: current.latencyMs === undefined ? latencyMs : current.latencyMs * 0.7 + latencyMs * 0.3 }),
    })
    const infrastructureId = MatrixCatalog.infrastructureId(candidate)
    const infrastructure = this.infrastructureStates.get(infrastructureId) ?? freshInfrastructureState
    this.infrastructureStates.set(infrastructureId, {
      health: Math.min(1, infrastructure.health + 0.1),
      cooldownUntil: 0,
      recentFailures: 0,
      successes: infrastructure.successes + 1,
      failures: infrastructure.failures,
    })
    if (profile !== undefined) this.preferred.set(profile, candidate.id)
  }

  state(candidate: MatrixCatalog.Candidate): CandidateState | undefined {
    return this.states.get(candidate.id)
  }

  lastError(candidate: MatrixCatalog.Candidate): CandidateError | undefined {
    return this.states.get(candidate.id)?.lastError
  }

  // Read-only snapshot for diagnostics (/matrix-models).
  snapshot(): ReadonlyMap<string, CandidateState> {
    return new Map(this.states)
  }

  infrastructureSnapshot(): ReadonlyMap<string, InfrastructureState> {
    return new Map(this.infrastructureStates)
  }

  infrastructureState(candidate: MatrixCatalog.Candidate): InfrastructureState | undefined {
    return this.infrastructureStates.get(MatrixCatalog.infrastructureId(candidate))
  }

  infrastructureHealth(candidate: MatrixCatalog.Candidate): number {
    const state = this.infrastructureState(candidate)
    if (state === undefined) return 1
    if (state.cooldownUntil <= this.now()) return 1
    return Math.min(state.health, 0.5)
  }

  // Replace all observed state, e.g. when a TUI mirrors the server-recorded
  // routing state from a routing snapshot. Unknown candidate IDs are dropped.
  restore(states: ReadonlyMap<string, CandidateState>): void {
    this.states.clear()
    for (const [id, state] of states) this.states.set(id, { ...state })
  }

  preferredCandidate(profile: MatrixProfile.ProfileID): string | undefined {
    return this.preferred.get(profile)
  }

  health(candidate: MatrixCatalog.Candidate): number {
    return this.state(candidate)?.health ?? 1
  }
}

function failureScope(error: Omit<CandidateError, "at"> | undefined): MatrixProvider.FailureScope {
  const message = error?.message.toLowerCase() ?? ""
  if (error?.status === 429 || error?.status === 402) return "route"
  if (
    (error?.status === 400 || error?.status === 401 || error?.status === 404) &&
    /model (?:is )?not supported|unsupported model|unknown model|model_not_found/.test(message)
  )
    return "route"
  if (error?.status === 401 || error?.status === 403) return "credential"
  if (error?.status === 400 || error?.status === 408 || error?.status === 422) return "request"
  if (
    error?.status === 500 ||
    error?.status === 502 ||
    error?.status === 503 ||
    error?.status === 504 ||
    /timeout|connection refused|provider offline|cannot connect to api/.test(message)
  )
    return "infrastructure"
  return "request"
}

export function make(now?: () => number): Router {
  return new Router(now)
}
