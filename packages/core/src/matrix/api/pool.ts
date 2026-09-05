// Direct provider pool for the local OpenAI-compatible Matrix API.
//
// The Matrix API must never chat through the OmniRoute path that could call
// Matrix (recursion). Instead it chats through its OWN direct provider pool:
// real, OpenAI-compatible, cost-0 providers that Matrix can reach directly.
// Each candidate activates only when its standard credential env var is
// present; availability is therefore environment-driven and no credential ever
// lives in source or in status output.
//
// Candidates come from the opencode provider registry (the same ecosystem
// Matrix ships): model ids, base URLs and environments are real provider
// contracts, not invented. Classification is computed per candidate:
//
//   DIRECT_FREE          cost-0 model, credential present, direct reach
//   DIRECT_AUTHENTICATED non-free model with a credential (e.g. an explicit
//                        MATRIX_API_DIRECT_* override route)
//   OMNIROUTE_BACKED     would call back through the OmniRoute gateway; never
//                        eligible for execution
//   UNAVAILABLE          credential missing or endpoint unsafe at the moment

export * as MatrixApiPool from "./pool"

import { MatrixCatalog } from "../catalog"
import { routesToOmniRoute, type Settings } from "./config"

export type Classification = "DIRECT_FREE" | "DIRECT_AUTHENTICATED" | "OMNIROUTE_BACKED" | "UNAVAILABLE"

export type Env = Readonly<Record<string, string | undefined>>

// A provider Matrix may route to directly. `candidate` carries the routing
// metadata the matrix router scores; `baseURL`/`keyEnv` resolve the outbound
// OpenAI-compatible call. `free` marks cost-0 models (DIRECT_FREE eligible).
export interface DirectCandidate {
  readonly candidate: MatrixCatalog.Candidate
  readonly baseURL: string
  readonly keyEnv: string
  readonly free: boolean
}

export interface PoolEntry extends DirectCandidate {
  readonly classification: Classification
}

export interface ResolvedPool {
  readonly free: readonly PoolEntry[]
  readonly authenticated: readonly PoolEntry[]
  readonly omniroute: readonly PoolEntry[]
  readonly unavailable: readonly PoolEntry[]
  readonly all: readonly PoolEntry[]
}

// Matrix's own free/direct pool. Real providers with verified cost-0 models:
//   - OpenRouter "Free Models Router" (model `free`) Ã¢â‚¬â€ free, multimodal, tool use.
//   - Cerebras GLM-5-Turbo Ã¢â‚¬â€ free GLM model with tool use + reasoning.
// Both speak the OpenAI-compatible wire format the executor already uses.
export const POOL: readonly DirectCandidate[] = [
  {
    candidate: {
      id: "openrouter/nemotron-3-ultra-free",
      name: "OpenRouter Nemotron 3 Ultra Free",
      provider: "openrouter",
      model: "nvidia/nemotron-3-ultra-550b-a55b:free",
      coding: 0.7,
      reasoning: 0.7,
      speed: 0.6,
      toolCalls: 0.8,
      vision: true,
      cost: 0,
      context: 200000,
    },
    baseURL: "https://openrouter.ai/api/v1",
    keyEnv: "OPENROUTER_API_KEY",
    free: true,
  },
  {
    candidate: {
      id: "cerebras/glm-5-turbo",
      name: "Cerebras GLM-5-Turbo",
      provider: "cerebras",
      model: "glm-5-turbo",
      coding: 0.8,
      reasoning: 0.8,
      speed: 0.8,
      toolCalls: 0.8,
      vision: false,
      cost: 0,
      context: 200000,
    },
    baseURL: "https://api.cerebras.ai/v1",
    keyEnv: "CEREBRAS_API_KEY",
    free: true,
  },
]

// Optional per-candidate base URL override (Settings.poolBaseURLOverrides),
// keyed by candidate id. Lets an operator point a candidate at a self-hosted
// mirror of the same provider; never routes through the OmniRoute gateway.
function effectiveBaseURL(entry: DirectCandidate, settings: Settings): string {
  const override = settings.poolBaseURLOverrides?.[entry.candidate.id]?.trim()
  return override === undefined || override === "" ? entry.baseURL : override
}

// The legacy explicit override becomes an authenticated direct route when a
// non-OmniRoute MATRIX_API_DIRECT_BASE_URL is configured.
export function overrideEntry(settings: Settings): PoolEntry | undefined {
  if (settings.directBaseURL === undefined) return undefined
  const unsafe = routesToOmniRoute(settings.directBaseURL, settings.omnirouteBaseURL)
  return {
    candidate: {
      id: "matrix-api/direct",
      name: "Matrix API Direct Override",
      provider: "matrix-api",
      model: "direct",
      coding: 0.6,
      reasoning: 0.6,
      speed: 0.6,
      toolCalls: 0.7,
      vision: false,
      cost: 3,
      context: 128000,
    },
    baseURL: settings.directBaseURL,
    keyEnv: "MATRIX_API_DIRECT_API_KEY",
    free: false,
    classification: unsafe ? "OMNIROUTE_BACKED" : "DIRECT_AUTHENTICATED",
  }
}

// Credential accessor for an entry. Only the raw env value is a secret; the
// KEY NAME (keyEnv) is safe to display. The override reads its dedicated key
// (or passthrough auth) from Settings instead of the environment.
export function credential(entry: Pick<PoolEntry, "candidate" | "keyEnv">, settings: Settings, env: Env): string | undefined {
  if (entry.candidate.id === "matrix-api/direct") return settings.directApiKey
  return env[entry.keyEnv]?.trim() || undefined
}

function classify(entry: DirectCandidate, settings: Settings, env: Env): Classification {
  const unsafe = routesToOmniRoute(effectiveBaseURL(entry, settings), settings.omnirouteBaseURL)
  if (unsafe) return "OMNIROUTE_BACKED"
  if (credential(entry, settings, env) === undefined) return "UNAVAILABLE"
  return entry.free ? "DIRECT_FREE" : "DIRECT_AUTHENTICATED"
}

export function resolvePool(settings: Settings, env: Env = process.env): ResolvedPool {
  const withOverrides: readonly DirectCandidate[] = POOL.map((entry) => ({
    ...entry,
    baseURL: effectiveBaseURL(entry, settings),
  }))
  const override = overrideEntry(settings)
  const entries: readonly PoolEntry[] = [...withOverrides, ...(override === undefined ? [] : [override])].map(
    (entry) => ({ ...entry, classification: classify(entry, settings, env) }),
  )
  const outflow = {
    free: [] as PoolEntry[],
    authenticated: [] as PoolEntry[],
    omniroute: [] as PoolEntry[],
    unavailable: [] as PoolEntry[],
  }
  for (const entry of entries) {
    outflow[entry.classification === "DIRECT_FREE" ? "free" : entry.classification === "DIRECT_AUTHENTICATED" ? "authenticated" : entry.classification === "OMNIROUTE_BACKED" ? "omniroute" : "unavailable"].push(entry)
  }
  return { ...outflow, all: entries }
}

// True when the pool offers at least one DIRECT_FREE candidate the executor may
// use without any explicit override configuration.
export function hasFreeRoute(settings: Settings, env: Env = process.env): boolean {
  return resolvePool(settings, env).free.length > 0
}

// ---------------------------------------------------------------------------
// Status / audit (secret-free)
// ---------------------------------------------------------------------------

export interface PoolCandidateStatus {
  readonly id: string
  readonly name: string
  readonly classification: Classification
}

export interface PoolStatus {
  readonly candidates: ReadonlyArray<PoolCandidateStatus>
  readonly eligibleFree: number
  readonly rejectedOmniRouteBacked: ReadonlyArray<string>
  readonly override: {
    readonly configured: boolean
    readonly safe: boolean
    readonly active: boolean
  }
}

// Audit every candidate Matrix knows about (pool + catalog) so the status
// endpoint can report eligible free candidates, rejected OmniRoute-backed ones
// and the override state without ever exposing credentials.
export function poolStatus(settings: Settings, env: Env = process.env): PoolStatus {
  const resolved = resolvePool(settings, env)
  const catalogAudit: readonly PoolEntry[] = [
    ...MatrixCatalog.CATALOG,
    ...MatrixCatalog.VISION_CANDIDATES,
  ].map((candidate) => ({
    candidate,
    baseURL: "",
    keyEnv: "",
    free: false,
    classification: "OMNIROUTE_BACKED" as const,
  }))
  const candidates: readonly PoolCandidateStatus[] = [...resolved.all, ...catalogAudit].map((entry) => ({
    id: entry.candidate.id,
    name: entry.candidate.name,
    classification: entry.classification,
  }))
  const override = overrideEntry(settings)
  return {
    candidates,
    eligibleFree: resolved.free.length,
    rejectedOmniRouteBacked: [
      ...resolved.omniroute.map((entry) => entry.candidate.id),
      ...catalogAudit.map((entry) => entry.candidate.id),
    ],
    override: {
      configured: settings.directBaseURL !== undefined,
      safe: override?.classification === "DIRECT_AUTHENTICATED",
      active: override?.classification === "DIRECT_AUTHENTICATED" && resolved.free.length === 0,
    },
  }
}
