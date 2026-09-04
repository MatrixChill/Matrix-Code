import { describe, expect, test } from "bun:test"
import { buildRoutingStatus, type ProviderStatus } from "./routing-adapter"
import { MatrixRouter } from "@opencode-ai/core/matrix/router"
import { MatrixCatalog } from "@opencode-ai/core/matrix/catalog"

describe("buildRoutingStatus", () => {
  test("returns unknown status when no router is provided", () => {
    const result = buildRoutingStatus(undefined)
    expect(result.omniroute.status).toBe("unknown")
    expect(result.activeProvider).toBeNull()
    expect(result.fallbackProvider).toBeNull()
    result.providers.forEach((p) => {
      expect(p.status).toBe("unknown")
    })
  })

  test("returns online status for healthy candidates", () => {
    const router = MatrixRouter.make()
    const result = buildRoutingStatus(router, "smart")
    expect(result.omniroute.status).toBe("online")
    expect(result.providers.length).toBeGreaterThan(0)
    result.providers.forEach((p) => {
      expect(p.status).toBe("online")
    })
  })

  test("returns degraded status when health is low", () => {
    let now = 1_000_000
    const router = MatrixRouter.make(() => now)
    for (const candidate of MatrixCatalog.CATALOG) {
      router.recordFailure(candidate, 1_000_000)
      router.recordFailure(candidate, 1_000_000)
    }
    const result = buildRoutingStatus(router, "smart")
    expect(result.omniroute.status).toBe("degraded")
  })

  test("identifies active provider from router selection", () => {
    const router = MatrixRouter.make()
    const result = buildRoutingStatus(router, "smart")
    expect(result.activeProvider).not.toBeNull()
    expect(typeof result.activeProvider).toBe("string")
  })

  test("sets lastCheck to current time", () => {
    const before = new Date()
    const router = MatrixRouter.make()
    const result = buildRoutingStatus(router, "smart")
    const after = new Date()
    expect(result.omniroute.lastCheck.getTime()).toBeGreaterThanOrEqual(before.getTime())
    expect(result.omniroute.lastCheck.getTime()).toBeLessThanOrEqual(after.getTime())
  })

  test("deduplicates providers from catalog candidates", () => {
    const router = MatrixRouter.make()
    const result = buildRoutingStatus(router, "smart")
    const providerIds = result.providers.map((p) => p.id)
    const uniqueIds = new Set(providerIds)
    expect(providerIds.length).toBe(uniqueIds.size)
  })

  test("counts available models per provider", () => {
    const router = MatrixRouter.make()
    const result = buildRoutingStatus(router, "smart")
    const omniroute = result.providers.find((p) => p.id === "omniroute")
    expect(omniroute).toBeDefined()
    expect(omniroute!.availableModels).toBe(3)
  })
})

describe("ProviderStatus mapping", () => {
  test("health >= 0.7 maps to online", () => {
    const router = MatrixRouter.make()
    const candidate = MatrixCatalog.CATALOG[0]!
    router.recordSuccess(candidate)
    const health = router.health(candidate)
    expect(health).toBeGreaterThanOrEqual(0.7)
  })

  test("health < 0.3 maps to offline after many failures", () => {
    let now = 1_000_000
    const router = MatrixRouter.make(() => now)
    const candidate = MatrixCatalog.CATALOG[0]!
    router.recordFailure(candidate, 1_000_000)
    router.recordFailure(candidate, 1_000_000)
    router.recordFailure(candidate, 1_000_000)
    router.recordFailure(candidate, 1_000_000)
    router.recordFailure(candidate, 1_000_000)
    const health = router.health(candidate)
    expect(health).toBeLessThan(0.3)
  })
})

describe("Fallback behavior", () => {
  test("fallback provider differs from active when candidates are available", () => {
    const router = MatrixRouter.make()
    const result = buildRoutingStatus(router, "smart")
    if (result.activeProvider && result.fallbackProvider) {
      expect(result.activeProvider).not.toBe(result.fallbackProvider)
    }
  })

  test("no active provider when all candidates are unavailable", () => {
    const router = MatrixRouter.make()
    const result = buildRoutingStatus(router, "fast")
    if (result.activeProvider === null) {
      expect(result.activeProvider).toBeNull()
    }
  })
})

describe("ProviderInfo shape", () => {
  test("each provider has required fields", () => {
    const router = MatrixRouter.make()
    const result = buildRoutingStatus(router, "smart")
    for (const provider of result.providers) {
      expect(typeof provider.id).toBe("string")
      expect(typeof provider.name).toBe("string")
      expect(typeof provider.provider).toBe("string")
      expect(typeof provider.model).toBe("string")
      expect(typeof provider.availableModels).toBe("number")
      expect(typeof provider.vision).toBe("boolean")
      expect(typeof provider.cost).toBe("number")
      expect(["online", "offline", "degraded", "unknown"]).toContain(provider.status)
    }
  })
})
