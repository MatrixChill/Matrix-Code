import { describe, expect, test } from "bun:test"
import { MatrixProvider } from "./provider"
import { MatrixRoute } from "./route"

describe("MatrixProvider Foundation", () => {
  test("registry contains exactly the expected initial providers", () => {
    expect(MatrixProvider.listProviders().map((provider) => provider.id)).toEqual([
      "omniroute",
      "openrouter",
      "cerebras",
      "ollama",
    ])
  })

  test("provider IDs are unique", () => {
    const providers = MatrixProvider.listProviders()
    expect(new Set(providers.map((provider) => provider.id)).size).toBe(providers.length)
  })

  test("provider kind and protocol describe role and wire protocol separately", () => {
    const omniroute = MatrixProvider.getProvider("omniroute")!
    expect(omniroute.kind).toBe("gateway")
    expect(omniroute.protocol).toBe("openai-compatible")

    for (const id of ["openrouter", "cerebras"]) {
      const provider = MatrixProvider.getProvider(id)!
      expect(provider.kind).toBe("direct")
      expect(provider.protocol).toBe("openai-compatible")
    }
  })

  test("separates product access from HTTP authentication", () => {
    expect(MatrixProvider.getProvider("omniroute")?.access).toBe("managed")
    expect(MatrixProvider.getProvider("openrouter")?.access).toBe("api-key")
    expect(MatrixProvider.getProvider("cerebras")?.access).toBe("api-key")
    expect(MatrixProvider.getProvider("ollama")).toMatchObject({
      kind: "local",
      protocol: "openai-compatible",
      auth: { type: "none" },
      access: "local",
    })
  })

  test("OmniRoute has a runtime endpoint and direct providers have static endpoints", () => {
    expect(MatrixProvider.getProvider("omniroute")!.endpoint).toEqual({
      type: "runtime",
      configKey: "OMNIROUTE_BASE_URL",
    })
    expect(MatrixProvider.getProvider("openrouter")!.endpoint).toEqual({
      type: "static",
      baseURL: "https://openrouter.ai/api/v1",
    })
    expect(MatrixProvider.getProvider("cerebras")!.endpoint).toEqual({
      type: "static",
      baseURL: "https://api.cerebras.ai/v1",
    })
  })

  test("bearer auth stores only environment variable names and no secrets", () => {
    for (const provider of MatrixProvider.listProviders().filter((provider) => provider.auth.type === "bearer")) {
      expect(provider.auth.type).toBe("bearer")
      if (provider.auth.type !== "bearer") continue
      expect(provider.auth.apiKeyEnv).toMatch(/^[A-Z][A-Z0-9_]*$/)
      expect(Object.keys(provider)).not.toContain("secret")
      expect(Object.keys(provider)).not.toContain("key")
      expect(Object.keys(provider)).not.toContain("token")
    }
  })

  test("auth none does not require apiKeyEnv", () => {
    const auth: MatrixProvider.ProviderAuth = { type: "none" }
    expect("apiKeyEnv" in auth).toBe(false)
  })

  test("looks up existing and missing providers", () => {
    expect(MatrixProvider.getProvider("omniroute")?.id).toBe("omniroute")
    expect(MatrixProvider.getProvider("unknown")).toBeUndefined()
  })
})

describe("MatrixRoute Foundation", () => {
  test("route IDs are unique and reference registered providers", () => {
    const routes = MatrixRoute.listRoutes()
    expect(new Set(routes.map((route) => route.id)).size).toBe(routes.length)
    for (const route of routes) expect(MatrixProvider.getProvider(route.providerId)).toBeDefined()
  })

  test("separates OmniRoute automatic and known backend infrastructure", () => {
    const routes = MatrixRoute.listRoutes()
    expect(routes.find((route) => route.id === "omniroute/matrix-free-coding")?.infrastructureId).toBe("omniroute-auto")
    expect(routes.find((route) => route.id === "omniroute/matrix-vision")?.infrastructureId).toBe("opencode")
    for (const route of routes) expect(route.infrastructureId.length).toBeGreaterThan(0)
  })

  test("matches the v1.0.2 OmniRoute metadata", () => {
    const routes = MatrixRoute.listRoutes()
    expect(routes.find((route) => route.id === "omniroute/matrix-free-coding")).toMatchObject({
      modelId: "auto/coding:free",
      capabilities: { vision: false, toolCalls: true, streaming: true, maxContext: 128000 },
      scoring: { coding: 0.8, reasoning: 0.7, speed: 0.6, toolCalls: 0.8, cost: 0 },
    })
    expect(routes.find((route) => route.id === "omniroute/matrix-vision")).toMatchObject({
      modelId: "opencode/mimo-v2.5-free",
      capabilities: { vision: true, toolCalls: true, streaming: true, maxContext: 128000 },
      scoring: { coding: 0.7, reasoning: 0.7, speed: 0.7, toolCalls: 0.7, cost: 0 },
    })
  })

  test("has valid capabilities and bounded scoring", () => {
    for (const route of MatrixRoute.listRoutes()) {
      expect(typeof route.capabilities.vision).toBe("boolean")
      expect(typeof route.capabilities.toolCalls).toBe("boolean")
      expect(typeof route.capabilities.streaming).toBe("boolean")
      expect(route.capabilities.maxContext).toBeGreaterThan(0)
      for (const score of [
        route.scoring.coding,
        route.scoring.reasoning,
        route.scoring.speed,
        route.scoring.toolCalls,
      ]) {
        expect(score).toBeGreaterThanOrEqual(0)
        expect(score).toBeLessThanOrEqual(1)
      }
      expect(route.scoring.cost).toBeGreaterThanOrEqual(0)
      expect(route.scoring.cost).toBeLessThanOrEqual(5)
    }
  })

  test("gets routes by provider", () => {
    const routes = MatrixRoute.getRoutesForProvider("omniroute")
    expect(routes.length).toBeGreaterThan(0)
    expect(routes.every((route) => route.providerId === "omniroute")).toBe(true)
    expect(MatrixRoute.getRoutesForProvider("unknown")).toEqual([])
  })
})
