import { describe, expect, test } from "bun:test"
import {
  buildRoutingStatus,
  type GatewayProbe,
  type ProviderStatus,
} from "./routing-adapter"
import { MatrixRouter } from "@opencode-ai/core/matrix/router"
import { MatrixCatalog } from "@opencode-ai/core/matrix/catalog"

const gatewayOnline = (checkedAt = new Date()): GatewayProbe => ({
  reachable: true,
  statusCode: 200,
  checkedAt,
})

const gatewayOffline = (checkedAt = new Date()): GatewayProbe => ({
  reachable: false,
  error: "TimeoutError",
  checkedAt,
})

function failAllProviders(router: MatrixRouter.Router, status: number) {
  for (const candidate of MatrixCatalog.CATALOG) {
    for (let i = 0; i < 3; i++) {
      router.recordFailure(candidate, 1_000_000, { message: "provider error", status })
    }
  }
}

describe("buildRoutingStatus", () => {
  test("keeps everything unknown when no live information is available", () => {
    const result = buildRoutingStatus(undefined)
    expect(result.gateway.status).toBe("unknown")
    expect(result.routingStatus).toBe("unknown")
    expect(result.activeProvider).toBeNull()
    expect(result.fallbackProvider).toBeNull()
    expect(result.lastError).toBeUndefined()
    result.providers.forEach((p) => {
      expect(p.status).toBe("unknown")
    })
  })

  test("gateway online while provider is offline with HTTP 500", () => {
    const router = MatrixRouter.make()
    failAllProviders(router, 500)
    const result = buildRoutingStatus(router, "smart", gatewayOnline())
    expect(result.gateway.status).toBe("online")
    const omniroute = result.providers.find((p) => p.id === "omniroute")!
    expect(omniroute.status).toBe("offline")
    expect(omniroute.lastError?.status).toBe(500)
    expect(result.routingStatus).toBe("offline")
  })

  test("gateway offline leaves provider status unknown", () => {
    const router = MatrixRouter.make()
    const result = buildRoutingStatus(router, "smart", gatewayOffline())
    expect(result.gateway.status).toBe("offline")
    expect(result.gateway.error).toBe("TimeoutError")
    result.providers.forEach((p) => {
      expect(p.status).toBe("unknown")
    })
  })

  test("surfaces provider HTTP 504 in the last error", () => {
    const router = MatrixRouter.make()
    failAllProviders(router, 504)
    const result = buildRoutingStatus(router, "smart", gatewayOnline())
    const omniroute = result.providers.find((p) => p.id === "omniroute")!
    expect(omniroute.lastError?.status).toBe(504)
    expect(result.lastError?.status).toBe(504)
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

  test("fallback provider differs from active when candidates are available", () => {
    const router = MatrixRouter.make()
    const result = buildRoutingStatus(router, "smart")
    if (result.activeProvider && result.fallbackProvider) {
      expect(result.activeProvider).not.toBe(result.fallbackProvider)
    }
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
    for (let i = 0; i < 5; i++) {
      router.recordFailure(candidate, 1_000_000)
    }
    const health = router.health(candidate)
    expect(health).toBeLessThan(0.3)
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
      expect(typeof provider.recentFailures).toBe("number")
      expect(["online", "offline", "degraded", "unknown"] as ProviderStatus[]).toContain(provider.status)
      expect(provider.health === null || typeof provider.health === "number").toBe(true)
    }
  })
})