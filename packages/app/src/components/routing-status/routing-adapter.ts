import { MatrixCatalog } from "@opencode-ai/core/matrix/catalog"
import { MatrixRouter } from "@opencode-ai/core/matrix/router"
import { MatrixProfile } from "@opencode-ai/core/matrix/profile"

export type ProviderStatus = "online" | "offline" | "degraded" | "unknown"

export interface ProviderInfo {
  readonly id: string
  readonly name: string
  readonly provider: string
  readonly model: string
  readonly status: ProviderStatus
  readonly availableModels: number
  readonly vision: boolean
  readonly cost: number
}

export interface RoutingStatusData {
  readonly omniroute: {
    readonly status: ProviderStatus
    readonly lastCheck: Date
  }
  readonly providers: ReadonlyArray<ProviderInfo>
  readonly activeProvider: string | null
  readonly fallbackProvider: string | null
}

function mapHealthToStatus(health: number): ProviderStatus {
  if (health >= 0.7) return "online"
  if (health >= 0.3) return "degraded"
  return "offline"
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
      availableModels: models.length,
      vision: models.some((m) => m.vision),
      cost: Math.min(...models.map((m) => m.cost)),
    }
  })
}

export function buildRoutingStatus(
  router: MatrixRouter.Router | undefined,
  profile: MatrixProfile.ProfileID = "smart",
): RoutingStatusData {
  const candidates = MatrixCatalog.CATALOG
  const providers = deduplicateProviders(candidates)

  const enriched = providers.map((p) => {
    if (!router) return { ...p, status: "unknown" as ProviderStatus }
    const providerCandidates = candidates.filter((c) => c.provider === p.provider)
    const avgHealth = providerCandidates.reduce((sum, c) => sum + router.health(c), 0) / providerCandidates.length
    return { ...p, status: mapHealthToStatus(avgHealth) }
  })

  let activeProvider: string | null = null
  let fallbackProvider: string | null = null

  if (router) {
    const selection = router.select(profile, candidates, () => true)
    if (selection) {
      activeProvider = selection.candidate.provider
    }
    const fallbackSelection = router.fallback(profile, candidates, () => true)
    if (fallbackSelection && fallbackSelection.candidate.provider !== activeProvider) {
      fallbackProvider = fallbackSelection.candidate.provider
    }
  }

  const omnirouteOnline = enriched.some((p) => p.provider === "omniroute" && p.status === "online")
  const omnirouteDegraded = enriched.some((p) => p.provider === "omniroute" && p.status === "degraded")

  return {
    omniroute: {
      status: !router ? "unknown" : omnirouteOnline ? "online" : omnirouteDegraded ? "degraded" : "offline",
      lastCheck: new Date(),
    },
    providers: enriched,
    activeProvider,
    fallbackProvider,
  }
}
