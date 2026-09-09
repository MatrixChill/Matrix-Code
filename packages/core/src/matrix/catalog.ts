export * as MatrixCatalog from "./catalog"

// A candidate model in the Matrix catalog. The router ranks candidates per
// profile using the metadata below. Health and latency are runtime state managed
// by the router (not stored here); recent failures feed the health state.
export interface Candidate {
  readonly id: string
  readonly name: string
  readonly provider: string
  // Gateway-facing model id: the string the OmniRoute gateway expects as
  // `model` in a chat completion. The opencode provider config aliases point
  // here (`matrix-free-coding` -> `auto/coding:free`), and the session runner records
  // success/failure against this same id, so candidate matching only works when
  // it is the real wire id.
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

// Tuned metadata per OmniRoute route, keyed by the gateway's own model id (the
// string the gateway actually serves). Single source of truth for both the
// built-in CATALOG and the live-discovered candidates, so known routes reuse
// their tuning instead of heuristic guesses when the gateway is reachable.
interface GatewayRoute {
  readonly id: string
  readonly name: string
  readonly coding: number
  readonly reasoning: number
  readonly speed: number
  readonly toolCalls: number
  readonly vision: boolean
  readonly cost: number
  readonly context: number
}

const GATEWAY_ROUTES: Readonly<Record<string, GatewayRoute>> = {
  auto: {
    id: "omniroute/matrix-auto",
    name: "OmniRoute Auto",
    coding: 0.7,
    reasoning: 0.7,
    speed: 0.7,
    toolCalls: 0.7,
    vision: false,
    cost: 3,
    context: 128000,
  },
  "auto/fast": {
    id: "omniroute/matrix-auto-fast",
    name: "OmniRoute Auto Fast",
    coding: 0.6,
    reasoning: 0.5,
    speed: 0.9,
    toolCalls: 0.7,
    vision: false,
    cost: 2,
    context: 128000,
  },
  "auto/coding": {
    id: "omniroute/matrix-coding-auto",
    name: "OmniRoute Coding",
    coding: 0.8,
    reasoning: 0.7,
    speed: 0.6,
    toolCalls: 0.8,
    vision: false,
    cost: 2,
    context: 128000,
  },
  "auto/coding:free": {
    id: "omniroute/matrix-free-coding",
    name: "Matrix Free Auto",
    coding: 0.8,
    reasoning: 0.7,
    speed: 0.6,
    toolCalls: 0.8,
    vision: false,
    cost: 0,
    context: 128000,
  },
  "matrix/matrix-coding": {
    id: "omniroute/matrix-coding",
    name: "Matrix Coding",
    coding: 0.85,
    reasoning: 0.8,
    speed: 0.6,
    toolCalls: 0.85,
    vision: false,
    cost: 0,
    context: 128000,
  },
  "matrix/matrix-coding-reliable": {
    id: "omniroute/matrix-coding-reliable",
    name: "Matrix Coding Reliable",
    coding: 0.8,
    reasoning: 0.9,
    speed: 0.5,
    toolCalls: 0.9,
    vision: false,
    cost: 0,
    context: 128000,
  },
  "auto/vision": {
    id: "omniroute/matrix-vision",
    name: "Matrix Vision",
    coding: 0.4,
    reasoning: 0.5,
    speed: 0.6,
    toolCalls: 0.4,
    vision: true,
    cost: 2,
    context: 128000,
  },
}

// Central catalog. Kept small and clear: it is a registry of *candidate* models
// (mostly OmniRoute routes + a couple of direct providers), each tagged with
// metadata the router uses to pick a profile-matching model. Providers that are
// not configured (e.g. no API key) are dropped before ranking. Runtime
// discovery (fromGatewayModels) supersedes this list when the gateway answers.
export const CATALOG: readonly Candidate[] = [
  "auto",
  "auto/fast",
  "auto/coding:free",
  "matrix/matrix-coding",
  "matrix/matrix-coding-reliable",
].map((model) => ({ ...GATEWAY_ROUTES[model]!, provider: "omniroute", model }))

// Default candidates for the vision profile. These are intentionally separate:
// vision is a capability the router activates when the active model lacks it and
// the task needs an image.
export const VISION_CANDIDATES: readonly Candidate[] = [
  { ...GATEWAY_ROUTES["auto/vision"]!, provider: "omniroute", model: "auto/vision" },
]

export function byId(catalog: readonly Candidate[], id: string): Candidate | undefined {
  return catalog.find((candidate) => candidate.id === id)
}

export function supportsProfile(candidate: Candidate, profile: string): boolean {
  return candidate.profiles === undefined || candidate.profiles.includes(profile)
}

// A model the OmniRoute gateway advertises through its OpenAI-style /v1/models
// endpoint; the minimal fields Matrix needs to build a routable candidate.
export interface GatewayModel {
  readonly id: string
  readonly name?: string
  readonly context?: number
  readonly vision?: boolean
}

export const MAX_DISCOVERED_MODELS = 512

// Build the candidate catalog from the models a reachable OmniRoute gateway
// advertises. Known routes reuse their tuned metadata; unknown ids get
// conservative heuristics so they are routable and visible without hardcoding
// every model the gateway adds. Never throws: malformed or duplicate ids are
// skipped.
export function fromGatewayModels(models: readonly GatewayModel[]): readonly Candidate[] {
  const candidates: Candidate[] = []
  const seen = new Set<string>()
  for (const model of models) {
    if (candidates.length >= MAX_DISCOVERED_MODELS) break
    const id = model.id.trim()
    if (id.length === 0 || seen.has(id)) continue
    seen.add(id)
    const known = GATEWAY_ROUTES[id]
    candidates.push(known ? knownCandidate(id, known, model) : guessCandidate(id, model))
  }
  return candidates
}

function knownCandidate(id: string, known: GatewayRoute, model: GatewayModel): Candidate {
  const fromGateway = model.name?.trim()
  return {
    ...known,
    provider: "omniroute",
    model: id,
    // Prefer the tuned display name; the gateway often echoes the id as `name`.
    name: fromGateway && fromGateway !== id ? fromGateway : known.name,
    context: model.context ?? known.context,
  }
}

function guessCandidate(id: string, model: GatewayModel): Candidate {
  const lowered = id.toLowerCase()
  const vision = model.vision ?? /vision|image|multimodal/.test(lowered)
  const coding = /coding|code|dev|agent/.test(lowered) ? 0.85 : 0.6
  const reasoning = /reasoning|think|deep|careful/.test(lowered) ? 0.85 : coding * 0.9
  const speed = /fast|flash|mini|light|turbo/.test(lowered) ? 0.9 : 0.5
  const toolCalls = /coding|agent|tool/.test(lowered) ? 0.8 : 0.6
  return {
    id: `omniroute/${id}`,
    name: model.name?.trim() || id,
    provider: "omniroute",
    model: id,
    coding,
    reasoning,
    speed,
    toolCalls,
    vision,
    cost: /free/.test(lowered) ? 0 : 2,
    context: model.context ?? 128000,
    profiles: vision ? ["vision"] : ["smart", "coding-max", "reliable"],
  }
}
