export * as MatrixCatalog from "./catalog"

// A candidate model in the Matrix catalog. The router ranks candidates per
// profile using the metadata below. Health and latency are runtime state managed
// by the router (not stored here); recent failures feed the health state.
export interface Candidate {
  readonly id: string
  readonly name: string
  readonly provider: string
  readonly model: string
  // runtime/advisory multipliers in [0,1]
  readonly coding: number
  readonly reasoning: number
  readonly speed: number
  readonly toolCalls: number
  // vision capability of the candidate model itself
  readonly vision: boolean
  // 0..5 cost class, 0 = free, 5 = most expensive
  readonly cost: number
  // -1 = unknown, 0..262144 context window
  readonly context: number
  // profiles this candidate can serve; empty = all
  readonly profiles?: readonly string[]
}

// Central catalog. Kept small and clear: it is a registry of *candidate* models
// (mostly OmniRoute routes + a couple of direct providers), each tagged with
// metadata the router uses to pick a profile-matching model. Providers that are
// not configured (e.g. no API key) are dropped before ranking.
export const CATALOG: readonly Candidate[] = [
  {
    id: "omniroute/matrix-auto",
    name: "OmniRoute Auto",
    provider: "omniroute",
    model: "auto",
    coding: 0.7,
    reasoning: 0.7,
    speed: 0.7,
    toolCalls: 0.7,
    vision: false,
    cost: 3,
    context: 128000,
  },
  {
    id: "omniroute/matrix-auto-fast",
    name: "OmniRoute Auto Fast",
    provider: "omniroute",
    model: "auto/fast",
    coding: 0.6,
    reasoning: 0.5,
    speed: 0.9,
    toolCalls: 0.7,
    vision: false,
    cost: 2,
    context: 128000,
  },
  {
    id: "omniroute/matrix-free-coding",
    name: "OmniRoute Free Coding",
    provider: "omniroute",
    model: "matrix-free-coding",
    coding: 0.8,
    reasoning: 0.7,
    speed: 0.6,
    toolCalls: 0.8,
    vision: false,
    cost: 0,
    context: 128000,
  },
  {
    id: "omniroute/matrix-coding",
    name: "Matrix Coding",
    provider: "omniroute",
    model: "matrix-coding",
    coding: 0.85,
    reasoning: 0.8,
    speed: 0.6,
    toolCalls: 0.85,
    vision: false,
    cost: 0,
    context: 128000,
  },
  {
    id: "omniroute/matrix-coding-reliable",
    name: "Matrix Coding Reliable",
    provider: "omniroute",
    model: "matrix-coding-reliable",
    coding: 0.8,
    reasoning: 0.9,
    speed: 0.5,
    toolCalls: 0.9,
    vision: false,
    cost: 0,
    context: 128000,
  },
]

// Default candidates for the vision profile. These are intentionally separate:
// vision is a capability the router activates when the active model lacks it and
// the task needs an image.
export const VISION_CANDIDATES: readonly Candidate[] = [
  {
    id: "omniroute/matrix-vision",
    name: "Matrix Vision",
    provider: "omniroute",
    model: "auto/vision",
    coding: 0.4,
    reasoning: 0.5,
    speed: 0.6,
    toolCalls: 0.4,
    vision: true,
    cost: 2,
    context: 128000,
  },
]

export function byId(catalog: readonly Candidate[], id: string): Candidate | undefined {
  return catalog.find((candidate) => candidate.id === id)
}

export function supportsProfile(candidate: Candidate, profile: string): boolean {
  return candidate.profiles === undefined || candidate.profiles.includes(profile)
}
