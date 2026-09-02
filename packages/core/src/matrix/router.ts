export * as MatrixRouter from "./router"

import { MatrixCatalog } from "./catalog"
import { MatrixProfile, WEIGHTS } from "./profile"

// Runtime health for a candidate, tracked by the router instance.
export interface CandidateState {
  // 1.0 = healthy, decreasing with recent failures
  health: number
  // ms epoch when the candidate may be tried again; 0 = no cooldown
  cooldownUntil: number
  recentFailures: number
}

export interface Selection {
  readonly candidate: MatrixCatalog.Candidate
  readonly rank: number
  readonly profile: MatrixProfile.ProfileID
}

// Predicate: true when the provider is configured and the model is expected to work.
export type Available = (candidate: MatrixCatalog.Candidate) => boolean

const freshState: CandidateState = { health: 1, cooldownUntil: 0, recentFailures: 0 }

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

  constructor(private readonly now: () => number = () => Date.now()) {}

  private isCoolingDown(candidate: MatrixCatalog.Candidate): boolean {
    const state = this.states.get(candidate.id)
    return state !== undefined && state.cooldownUntil > this.now()
  }

  // Best available candidate for a profile; undefined when none usable.
  select(
    profile: MatrixProfile.ProfileID,
    candidates: readonly MatrixCatalog.Candidate[],
    isAvailable: Available,
  ): Selection | undefined {
    const ranked = candidates
      .filter((candidate) => MatrixCatalog.supportsProfile(candidate, profile))
      .filter(isAvailable)
      .filter((candidate) => !this.isCoolingDown(candidate))
      .sort((a, b) => score(b, profile) - score(a, profile))
    const top = ranked[0]
    if (top === undefined) return undefined
    return { candidate: top, rank: score(top, profile), profile }
  }

  // Degraded fallback: ignores health/cooldown so the user can still progress.
  fallback(
    profile: MatrixProfile.ProfileID,
    candidates: readonly MatrixCatalog.Candidate[],
    isAvailable: Available,
  ): Selection | undefined {
    return this.forceSelect(profile, candidates, isAvailable)
  }

  private forceSelect(
    profile: MatrixProfile.ProfileID,
    candidates: readonly MatrixCatalog.Candidate[],
    isAvailable: Available,
  ): Selection | undefined {
    const ranked = candidates
      .filter((candidate) => MatrixCatalog.supportsProfile(candidate, profile))
      .filter(isAvailable)
      .sort((a, b) => score(b, profile) - score(a, profile))
    const top = ranked[0]
    if (top === undefined) return undefined
    return { candidate: top, rank: score(top, profile), profile }
  }

  recordFailure(candidate: MatrixCatalog.Candidate, cooldownMs: number): void {
    const current = this.states.get(candidate.id) ?? freshState
    this.states.set(candidate.id, {
      health: Math.max(0, current.health - 0.25),
      cooldownUntil: this.now() + cooldownMs,
      recentFailures: current.recentFailures + 1,
    })
  }

  recordSuccess(candidate: MatrixCatalog.Candidate): void {
    const current = this.states.get(candidate.id) ?? freshState
    this.states.set(candidate.id, {
      health: Math.min(1, current.health + 0.1),
      cooldownUntil: 0,
      recentFailures: 0,
    })
  }

  state(candidate: MatrixCatalog.Candidate): CandidateState | undefined {
    return this.states.get(candidate.id)
  }

  // Read-only snapshot for diagnostics (/matrix-models).
  snapshot(): ReadonlyMap<string, CandidateState> {
    return new Map(this.states)
  }

  health(candidate: MatrixCatalog.Candidate): number {
    return this.state(candidate)?.health ?? 1
  }
}

export function make(now?: () => number): Router {
  return new Router(now)
}
