import { describe, expect, test } from "bun:test"
import { MatrixApiPool, type PoolEntry, type Classification } from "./pool"
import { MatrixApiConfig, type Settings } from "./config"

// Minimal Settings for pool tests
const testSettings = (overrides: Partial<Settings> = {}): Settings => ({
  enabled: true,
  host: "127.0.0.1",
  port: 20260,
  maxHops: 2,
  maxAttempts: 3,
  apiKey: "matrix-test-secret",
  ...overrides,
})

function env(overrides: Record<string, string | undefined> = {}) {
  return { ...process.env, ...overrides }
}

describe("Matrix API pool classification", () => {
  test("classifies OpenRouter Free as DIRECT_FREE when OPENROUTER_API_KEY is present", () => {
    const settings = testSettings({ poolEnv: env({ OPENROUTER_API_KEY: "sk-test-openrouter" }) })
    const resolved = MatrixApiPool.resolvePool(settings, settings.poolEnv)
    const entry = resolved.free.find((e) => e.candidate.id === "openrouter/free")
    expect(entry).toBeDefined()
    expect(entry?.classification).toBe("DIRECT_FREE")
  })

  test("classifies Cerebras GLM-5-Turbo as DIRECT_FREE when CEREBRAS_API_KEY is present", () => {
    const settings = testSettings({ poolEnv: env({ CEREBRAS_API_KEY: "csk-test-cerebras" }) })
    const resolved = MatrixApiPool.resolvePool(settings, settings.poolEnv)
    const entry = resolved.free.find((e) => e.candidate.id === "cerebras/glm-5-turbo")
    expect(entry).toBeDefined()
    expect(entry?.classification).toBe("DIRECT_FREE")
  })

  test("marks pool candidates as UNAVAILABLE when credential env var is missing", () => {
    const settings = testSettings({ poolEnv: env({}) })
    const resolved = MatrixApiPool.resolvePool(settings, settings.poolEnv)
    const openrouter = resolved.unavailable.find((e) => e.candidate.id === "openrouter/free")
    expect(openrouter).toBeDefined()
    expect(openrouter?.classification).toBe("UNAVAILABLE")
  })

  test("classifies legacy direct override as DIRECT_AUTHENTICATED when present and safe", () => {
    const settings = testSettings({
      directBaseURL: "https://api.other.example/v1",
      directApiKey: "sk-other",
      omnirouteBaseURL: "https://omniroute.example/v1",
      poolEnv: env({}),
    })
    const override = MatrixApiPool.overrideEntry(settings)
    expect(override).toBeDefined()
    expect(override?.classification).toBe("DIRECT_AUTHENTICATED")
  })

  test("classifies legacy direct override as OMNIROUTE_BACKED when it points to OmniRoute", () => {
    const settings = testSettings({
      directBaseURL: "https://omniroute.example/v1",
      directApiKey: "sk-other",
      omnirouteBaseURL: "https://omniroute.example/v1",
      poolEnv: env({}),
    })
    const override = MatrixApiPool.overrideEntry(settings)
    expect(override).toBeDefined()
    expect(override?.classification).toBe("OMNIROUTE_BACKED")
  })

  test("classifies legacy direct override as DIRECT_AUTHENTICATED when no OmniRoute is known (fallback safety)", () => {
    const settings = testSettings({
      directBaseURL: "https://api.example/v1",
      directApiKey: "sk-test",
      omnirouteBaseURL: undefined,
      poolEnv: env({}),
    })
    const override = MatrixApiPool.overrideEntry(settings)
    expect(override).toBeDefined()
    expect(override?.classification).toBe("DIRECT_AUTHENTICATED")
  })

  test("poolBaseURLOverrides re-homes a candidate before recursion check", () => {
    const settings = testSettings({
      directBaseURL: undefined,
      omnirouteBaseURL: "https://omniroute.example/v1",
      poolBaseURLOverrides: { "openrouter/free": "https://omniroute.example/v1" },
      poolEnv: env({ OPENROUTER_API_KEY: "sk-test" }),
    })
    const resolved = MatrixApiPool.resolvePool(settings, settings.poolEnv)
    const entry = resolved.all.find((e) => e.candidate.id === "openrouter/free")
    expect(entry).toBeDefined()
    expect(entry?.classification).toBe("OMNIROUTE_BACKED")
  })

  test("returns all candidate IDs in rejectedOmniRouteBacked in poolStatus", () => {
    const settings = testSettings({
      poolEnv: env({}),
    })
    const status = MatrixApiPool.poolStatus(settings, settings.poolEnv)
    expect(status.candidates.length).toBeGreaterThan(0)
    expect(status.eligibleFree).toBe(0)
    expect(status.rejectedOmniRouteBacked.length).toBeGreaterThan(0)
    expect(status.override.configured).toBe(false)
  })

  test("override status reports active when no free candidates exist and override is safe", () => {
    const settings = testSettings({
      directBaseURL: "https://api.other.example/v1",
      directApiKey: "sk-other",
      omnirouteBaseURL: "https://omniroute.example/v1",
      poolEnv: env({}),
    })
    const status = MatrixApiPool.poolStatus(settings, settings.poolEnv)
    expect(status.override.configured).toBe(true)
    expect(status.override.safe).toBe(true)
    expect(status.override.active).toBe(true)
  })

  test("override status reports inactive when safe free candidates exist", () => {
    const settings = testSettings({
      directBaseURL: "https://api.other.example/v1",
      directApiKey: "sk-other",
      omnirouteBaseURL: "https://omniroute.example/v1",
      poolEnv: env({ OPENROUTER_API_KEY: "sk-test" }),
    })
    const status = MatrixApiPool.poolStatus(settings, settings.poolEnv)
    expect(status.override.configured).toBe(true)
    expect(status.override.safe).toBe(true)
    expect(status.override.active).toBe(false)
  })

  test("credential extraction never returns the key value in poolStatus output", () => {
    const settings = testSettings({
      poolEnv: env({ OPENROUTER_API_KEY: "sk-real-secret-12345" }),
    })
    const status = MatrixApiPool.poolStatus(settings, settings.poolEnv)
    const json = JSON.stringify(status)
    expect(json).not.toContain("sk-real-secret-12345")
    expect(json).not.toContain("OPENROUTER_API_KEY")
  })

  test("credentials function returns undefined for UNAVAILABLE entries", () => {
    const settings = testSettings({ poolEnv: env({}) })
    const resolved = MatrixApiPool.resolvePool(settings, settings.poolEnv)
    const openrouter = resolved.unavailable.find((e) => e.candidate.id === "openrouter/free")
    expect(openrouter).toBeDefined()
    const cred = MatrixApiPool.credential(openrouter!, settings, settings.poolEnv ?? {})
    expect(cred).toBeUndefined()
  })

  test("credentials function returns the key for DIRECT_FREE entries", () => {
    const settings = testSettings({ poolEnv: env({ OPENROUTER_API_KEY: "sk-test-credential" }) })
    const resolved = MatrixApiPool.resolvePool(settings, settings.poolEnv)
    const openrouter = resolved.free.find((e) => e.candidate.id === "openrouter/free")
    expect(openrouter).toBeDefined()
    const cred = MatrixApiPool.credential(openrouter!, settings, settings.poolEnv ?? {})
    expect(cred).toBe("sk-test-credential")
  })

  test("pool includes both openrouter/free and cerebras/glm-5-turbo entries", () => {
    const allIds = MatrixApiPool.POOL.map((c) => c.candidate.id).sort()
    expect(allIds).toEqual(["cerebras/glm-5-turbo", "openrouter/free"])
  })
})

describe("Matrix API config extensions", () => {
  test("maxAttempts defaults to 3 and is clampable", () => {
    const settings = MatrixApiConfig.fromEnv({ MATRIX_API_MAX_ATTEMPTS: "5" })
    expect(settings.maxAttempts).toBe(5)
    const settings2 = MatrixApiConfig.fromEnv({ MATRIX_API_MAX_ATTEMPTS: "0" })
    expect(settings2.maxAttempts).toBe(1)
    const settings3 = MatrixApiConfig.fromEnv({ MATRIX_API_MAX_ATTEMPTS: "not-a-number" })
    expect(settings3.maxAttempts).toBe(3)
  })

  test("poolBaseURLOverrides parses valid JSON and ignores invalid", () => {
    const settings = MatrixApiConfig.fromEnv({
      MATRIX_API_POOL_BASE_URLS: '{"openrouter/free":"https://mirror/v1"}',
    })
    expect(settings.poolBaseURLOverrides).toEqual({ "openrouter/free": "https://mirror/v1" })
    const settings2 = MatrixApiConfig.fromEnv({ MATRIX_API_POOL_BASE_URLS: "not json" })
    expect(settings2.poolBaseURLOverrides).toBeUndefined()
    const settings3 = MatrixApiConfig.fromEnv({ MATRIX_API_POOL_BASE_URLS: '{"key": 123}' })
    expect(settings3.poolBaseURLOverrides).toBeUndefined()
    const settings4 = MatrixApiConfig.fromEnv({ MATRIX_API_POOL_BASE_URLS: '{"": ""}' })
    expect(settings4.poolBaseURLOverrides).toBeUndefined()
  })

  test("status includes maxAttempts", () => {
    const settings = testSettings({ maxAttempts: 7 })
    const status = MatrixApiConfig.status(settings)
    expect(status.maxAttempts).toBe(7)
  })
})
