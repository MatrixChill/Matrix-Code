import { describe, expect, test } from "bun:test"
import {
  buildRoutingStatus,
  mapHealthToStatus,
  type GatewayProbe,
} from "@opencode-ai/core/matrix/routing-status"
import { MatrixRouter } from "@opencode-ai/core/matrix/router"
import { MatrixCatalog } from "@opencode-ai/core/matrix/catalog"

function gatewayOnline(checkedAt = new Date()): GatewayProbe {
  return { reachable: true, statusCode: 200, checkedAt }
}

function gatewayOffline(checkedAt = new Date()): GatewayProbe {
  return { reachable: false, error: "TimeoutError", checkedAt }
}

function failAllProviders(router: MatrixRouter.Router, status: number, attempts = 3) {
  for (const candidate of MatrixCatalog.CATALOG) {
    for (let i = 0; i < attempts; i++) {
      router.recordFailure(candidate, 1_000_000, { message: "provider error", status })
    }
  }
}

describe("MatrixRoutingStatus", () => {
  test("keeps everything unknown when no live information is available", () => {
    const result = buildRoutingStatus(undefined)
    expect(result.gateway.status).toBe("unknown")
    expect(result.routingStatus).toBe("unknown")
    expect(result.activeProvider).toBeNull()
    expect(result.fallbackProvider).toBeNull()
    expect(result.lastError).toBeUndefined()
    result.providers.forEach((p) => {
      expect(p.status).toBe("unknown")
      expect(p.health).toBeNull()
      expect(p.lastError).toBeUndefined()
    })
  })

  test("a fresh router with no observations reports unknown, not online", () => {
    const router = MatrixRouter.make()
    const result = buildRoutingStatus(router, "smart")
    expect(result.gateway.status).toBe("unknown")
    expect(result.routingStatus).toBe("unknown")
    result.providers.forEach((p) => {
      expect(p.status).toBe("unknown")
      expect(p.health).toBeNull()
    })
  })

  test("is online only after a recorded success", () => {
    const router = MatrixRouter.make()
    router.recordSuccess(MatrixCatalog.CATALOG[0]!)
    const result = buildRoutingStatus(router, "smart")
    const omniroute = result.providers.find((p) => p.id === "omniroute")!
    expect(omniroute.status).toBe("online")
    expect(omniroute.health).not.toBeNull()
  })

  test("reports degraded status when recorded health is low", () => {
    let now = 1_000_000
    const router = MatrixRouter.make(() => now)
    for (const candidate of MatrixCatalog.CATALOG) {
      router.recordFailure(candidate, 1_000_000)
      router.recordFailure(candidate, 1_000_000)
    }
    const result = buildRoutingStatus(router, "smart")
    const omniroute = result.providers.find((p) => p.id === "omniroute")!
    expect(omniroute.status).toBe("degraded")
    expect(result.gateway.status).toBe("unknown")
  })

  test("gateway online while provider is offline with HTTP 500", () => {
    let now = 1_000_000
    const router = MatrixRouter.make(() => now)
    failAllProviders(router, 500)
    const result = buildRoutingStatus(router, "smart", gatewayOnline())
    expect(result.gateway.status).toBe("online")
    const omniroute = result.providers.find((p) => p.id === "omniroute")!
    expect(omniroute.status).toBe("offline")
    expect(omniroute.lastError?.status).toBe(500)
    expect(omniroute.lastError?.at.getTime()).toBe(now)
    expect(result.routingStatus).toBe("offline")
    expect(result.lastError?.status).toBe(500)
  })

  test("gateway offline leaves provider status unknown", () => {
    const router = MatrixRouter.make()
    const result = buildRoutingStatus(router, "smart", gatewayOffline())
    expect(result.gateway.status).toBe("offline")
    expect(result.gateway.error).toBe("TimeoutError")
    expect(result.routingStatus).toBe("unknown")
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
    expect(omniroute.lastError?.message).toBe("provider error")
    expect(result.lastError?.status).toBe(504)
  })

  test("records the probe status code and check time on the gateway", () => {
    const checkedAt = new Date(1_234_567)
    const result = buildRoutingStatus(undefined, "smart", gatewayOnline(checkedAt))
    expect(result.gateway.statusCode).toBe(200)
    expect(result.gateway.lastChecked).toEqual(checkedAt)
  })

  test("identifies active provider from router selection", () => {
    const router = MatrixRouter.make()
    const result = buildRoutingStatus(router, "smart")
    expect(result.activeProvider).not.toBeNull()
    expect(typeof result.activeProvider).toBe("string")
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
      expect(["online", "offline", "degraded", "unknown"]).toContain(provider.status)
      expect(provider.health === null || typeof provider.health === "number").toBe(true)
    }
  })

  test("fallback provider differs from active when candidates are available", () => {
    const router = MatrixRouter.make()
    const result = buildRoutingStatus(router, "smart")
    if (result.activeProvider && result.fallbackProvider) {
      expect(result.activeProvider).not.toBe(result.fallbackProvider)
    }
  })

  test("recent failures are reported per provider", () => {
    const router = MatrixRouter.make()
    failAllProviders(router, 500, 3)
    const result = buildRoutingStatus(router, "smart")
    const omniroute = result.providers.find((p) => p.id === "omniroute")!
    expect(omniroute.recentFailures).toBeGreaterThan(0)
  })
})

describe("mapHealthToStatus", () => {
  test("health >= 0.7 maps to online", () => {
    expect(mapHealthToStatus(0.7)).toBe("online")
    expect(mapHealthToStatus(1)).toBe("online")
  })

  test("health >= 0.3 and < 0.7 maps to degraded", () => {
    expect(mapHealthToStatus(0.3)).toBe("degraded")
    expect(mapHealthToStatus(0.5)).toBe("degraded")
  })

  test("health < 0.3 maps to offline", () => {
    expect(mapHealthToStatus(0)).toBe("offline")
    expect(mapHealthToStatus(0.29)).toBe("offline")
  })
})