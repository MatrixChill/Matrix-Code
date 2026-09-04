export * as MatrixRoutingStatus from "./routing-status"

import { MatrixCatalog } from "./catalog"
import { MatrixRouter } from "./router"
import { MatrixProfile } from "./profile"

// Health of a provider route as tracked by the router. "unknown" means the
// router has no recorded observations for it yet (no live information).
export type ProviderStatus = "online" | "offline" | "degraded" | "unknown"

// Reachability of the OmniRoute gateway itself. A gateway is "online" simply
// because it answered; that says nothing about the health of any provider
// route behind it (a running gateway can return 500/504 for a route).
export type GatewayStatus = "online" | "offline" | "unknown"

// Result of a live OmniRoute reachability probe, backed by the OpenAI-style
// /models endpoint. It only answers "did the gateway answer?".
export interface GatewayProbe {
  readonly reachable: boolean
  readonly statusCode?: number
  readonly error?: string
  readonly checkedAt: Date
}

export interface ProviderError {
  readonly message: string
  readonly code?: string
  readonly status?: number
  readonly at: Date
}

export interface ProviderInfo {
  readonly id: string
  readonly name: string
  readonly provider: string
  readonly model: string
  readonly status: ProviderStatus
  // Averaged router health over the provider's observed candidates; null when
  // the router has not recorded anything for this provider.
  readonly health: number | null
  readonly recentFailures: number
  readonly availableModels: number
  readonly vision: boolean
  readonly cost: number
  readonly lastError?: ProviderError
}

export interface RoutingStatusData {
  readonly gateway: {
    readonly status: GatewayStatus
    readonly statusCode?: number
    readonly error?: string
    readonly lastChecked: Date
  }
  // Overall health of the routing layer: the aggregate of provider statuses.
  readonly routingStatus: ProviderStatus
  readonly providers: ReadonlyArray<ProviderInfo>
  readonly activeProvider: string | null
  readonly fallbackProvider: string | null
  // Most recent provider error recorded across all providers, when available.
  readonly lastError?: ProviderError
  readonly lastUpdated: Date
}

export function mapHealthToStatus(health: number): ProviderStatus {
  if (health >= 0.7) return "online"
  if (health >= 0.3) return "degraded"
  return "offline"
}

function toProviderError(error: MatrixRouter.CandidateError): ProviderError {
  return {
    message: error.message,
    code: error.code,
    status: error.status,
    at: new Date(error.at),
  }
}

function deduplicateProviders(candidates: readonly MatrixCatalog.Candidate[]): ProviderInfo[] {
  const byProvider = new Map<string, MatrixCatalog.Candidate[]>()
  for (const candidate of candidates) {
    const existing = byProvider.get(candidate.provider) ?? []
    existing.push(candidate)
    byProvider.set(candidate.provider, existing)
  }

  return Array.from(byProvider.entries()).map(([provider, models]) => {
    const first = models[0]!
    return {
      id: provider,
      name: first.name.replace(/ .*/, ""),
      provider,
      model: models.map((m) => m.model).join(", "),
      status: "unknown" as ProviderStatus,
      health: null,
      recentFailures: 0,
      availableModels: models.length,
      vision: models.some((m) => m.vision),
      cost: Math.min(...models.map((m) => m.cost)),
    }
  })
}

// Merge the router's recorded observations (health, failures, last error) into
// a provider. Providers with no recorded observations stay "unknown".
function enrichProvider(router: MatrixRouter.Router, provider: ProviderInfo): ProviderInfo {
  const candidates = MatrixCatalog.CATALOG.filter((c) => c.provider === provider.provider)
  let observed = 0
  let healthTotal = 0
  let recentFailures = 0
  let lastError: MatrixRouter.CandidateError | undefined
  for (const candidate of candidates) {
    const state = router.state(candidate)
    if (state === undefined) continue
    observed += 1
    healthTotal += state.health
    recentFailures = Math.max(recentFailures, state.recentFailures)
    if (state.lastError !== undefined && (lastError === undefined || state.lastError.at > lastError.at)) {
      lastError = state.lastError
    }
  }
  if (observed === 0) return provider

  return {
    ...provider,
    status: mapHealthToStatus(healthTotal / observed),
    health: healthTotal / observed,
    recentFailures,
    ...(lastError === undefined ? {} : { lastError: toProviderError(lastError) }),
  }
}

function aggregateStatus(providers: ReadonlyArray<ProviderInfo>): ProviderStatus {
  const statuses = providers.map((p) => p.status)
  if (statuses.every((s) => s === "unknown")) return "unknown"
  if (statuses.every((s) => s === "online")) return "online"
  if (statuses.some((s) => s === "offline")) return "offline"
  return "degraded"
}

function pickLastError(providers: ReadonlyArray<ProviderInfo>): ProviderError | undefined {
  let latest: ProviderError | undefined
  for (const provider of providers) {
    if (provider.lastError !== undefined && (latest === undefined || provider.lastError.at.getTime() > latest.at.getTime())) {
      latest = provider.lastError
    }
  }
  return latest
}

// Build a routing status snapshot. Gateway reachability comes from a live probe
// (see omniRouteHealth.probe) and is fully independent of provider health: a
// gateway can be online while its provider routes return 500/504. When no probe
// or router observations are available the relevant fields stay "unknown".
export function buildRoutingStatus(
  router: MatrixRouter.Router | undefined,
  profile: MatrixProfile.ProfileID = "smart",
  gateway?: GatewayProbe,
): RoutingStatusData {
  const lastUpdated = new Date()
  const providers = deduplicateProviders(MatrixCatalog.CATALOG).map((provider) =>
    router === undefined ? provider : enrichProvider(router, provider),
  )

  let activeProvider: string | null = null
  let fallbackProvider: string | null = null
  if (router) {
    const selection = router.select(profile, MatrixCatalog.CATALOG, () => true)
    if (selection) {
      activeProvider = selection.candidate.provider
    }
    const fallbackSelection = router.fallback(profile, MatrixCatalog.CATALOG, () => true)
    if (fallbackSelection && fallbackSelection.candidate.provider !== activeProvider) {
      fallbackProvider = fallbackSelection.candidate.provider
    }
  }

  return {
    gateway: {
      status: gateway === undefined ? "unknown" : gateway.reachable ? "online" : "offline",
      statusCode: gateway?.statusCode,
      error: gateway?.error,
      lastChecked: gateway?.checkedAt ?? lastUpdated,
    },
    routingStatus: aggregateStatus(providers),
    providers,
    activeProvider,
    fallbackProvider,
    lastError: pickLastError(providers),
    lastUpdated,
  }
}