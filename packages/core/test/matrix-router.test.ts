import { describe, expect, test } from "bun:test"
import { MatrixRouter } from "@opencode-ai/core/matrix/router"
import { MatrixCatalog } from "@opencode-ai/core/matrix/catalog"
import { MatrixProfile, LABELS, PROFILE_IDS } from "@opencode-ai/core/matrix/profile"

const available = (candidate: MatrixCatalog.Candidate) => !candidate.id.includes("offline")

// A gateway-backed candidate and a configured independent direct provider side
// by side. A gateway failure cools its own route and its own infrastructure; it
// must never take the independent provider out of the pool with it.
const independent: MatrixCatalog.Candidate = {
  id: "openrouter/free",
  name: "OpenRouter Free Models Router",
  provider: "openrouter",
  infrastructureId: "openrouter-cloud",
  model: "openrouter/free",
  coding: 0.8,
  reasoning: 0.7,
  speed: 0.6,
  toolCalls: 0.8,
  vision: true,
  cost: 0,
  context: 32768,
}
const mixedPool = [...MatrixCatalog.RELIABLE_CANDIDATES, independent]

describe("MatrixProfile", () => {
  test("emergency fallback honors rate-limit cooldown until expiry but relaxes health cooldown", () => {
    let now = 1_000_000
    const router = MatrixRouter.make(() => now)
    const other = { ...independent, id: "other/free", provider: "other", infrastructureId: "other" }
    router.recordFailure(independent, 120_000, { status: 429, message: "Too many requests" }, "route")
    router.recordFailure(other, 120_000, { status: 503, message: "Unavailable" }, "route")
    expect(router.select("reliable", [independent], () => true)).toBeUndefined()
    expect(router.fallback("reliable", [independent], () => true)).toBeUndefined()
    expect(router.emergencyFallback("reliable", [independent], () => true)).toBeUndefined()
    expect(router.emergencyFallback("reliable", [independent, other], () => true)?.candidate.id).toBe(other.id)
    now += 119_999
    expect(router.emergencyFallback("reliable", [independent], () => true)).toBeUndefined()
    now += 1
    expect(router.select("reliable", [independent], () => true)?.candidate.id).toBe(independent.id)
    expect(router.fallback("reliable", [independent], () => true)?.candidate.id).toBe(independent.id)
    expect(router.emergencyFallback("reliable", [independent], () => true)?.candidate.id).toBe(independent.id)
  })

  test("exposes all seven profiles", () => {
    expect(PROFILE_IDS).toEqual([
      "smart",
      "coding-max",
      "reliable",
      "fast",
      "vision",
      "free",
      "local",
    ])
    expect(LABELS["reliable"]).toBe("Matrix Reliable")
  })

  test("validates profile identifiers", () => {
    expect(MatrixProfile.isProfile("fast")).toBe(true)
    expect(MatrixProfile.isProfile("nope")).toBe(false)
  })
})

describe("MatrixRouter score", () => {
  test("vision profile strongly favours a vision candidate", () => {
    const base = MatrixCatalog.CATALOG[0]
    const withVision = { ...base, id: "omniroute/vision-test", model: "auto/vision", vision: true }
    const visionScore = MatrixRouter.score(withVision, "vision")
    const noVisionScore = MatrixRouter.score(base, "vision")
    expect(visionScore).toBeGreaterThan(noVisionScore)
  })

  test("cheaper models score better on the free profile", () => {
    const base = MatrixCatalog.CATALOG[0]
    const cheap = { ...base, id: "omniroute/free-test", cost: 0 }
    const pricey = { ...base, id: "omniroute/pricey-test", cost: 5 }
    expect(MatrixRouter.score(cheap, "free")).toBeGreaterThan(MatrixRouter.score(pricey, "free"))
  })
})

describe("MatrixRouter selection and fallback", () => {
  test("picks the top-ranked available candidate for a profile", () => {
    const router = MatrixRouter.make()
    const selection = router.select("reliable", MatrixCatalog.CATALOG, available)
    expect(selection).toBeDefined()
    expect(selection!.profile).toBe("reliable")
  })

  test("cooldown pushes selection off the failed candidate, then recovers", () => {
    let now = 1_000_000
    const router = MatrixRouter.make(() => now)
    const first = MatrixCatalog.CATALOG[0]
    const topBefore = router.select("reliable", MatrixCatalog.CATALOG, available)!.candidate.id
    router.recordFailure(first, 10_000)
    // During cooldown, the failed candidate can no longer be selected.
    const during = router.select("reliable", MatrixCatalog.CATALOG, available)
    expect(during!.candidate.id).not.toBe(first.id)
    // After cooldown elapses, the candidate is eligible again and selection can
    // return to the pre-failure top choice (same set as before, since top ranked
    // candidate is eligible again and ranks above during-cooldown choices).
    now += 11_000
    const after = router.select("reliable", MatrixCatalog.CATALOG, available)
    expect(after!.candidate.id).toBe(topBefore)
    expect(router.state(first)!.cooldownUntil).toBeLessThan(now)
  })

  test("recordSuccess clears cooldown and raises health", () => {
    const router = MatrixRouter.make()
    const first = MatrixCatalog.CATALOG[0]
    router.recordFailure(first, 100_000)
    router.recordSuccess(first)
    expect(router.state(first)!.cooldownUntil).toBe(0)
    // health: 1 -> 0.75 on failure -> 0.85 on success
    expect(router.health(first)).toBe(0.85)
  })

  test("a failure with no error is route-scoped, never infrastructure-scoped", () => {
    const router = MatrixRouter.make(() => 1_000_000)
    const first = MatrixCatalog.CATALOG[0]
    router.recordFailure(first, 10_000)
    // No error means nothing to classify, so the failure is route-level. The
    // shared infrastructure must stay untouched, otherwise a sibling route on
    // the same backend would be cooled down by a failure it never had.
    expect(router.state(first)?.health).toBe(0.75)
    expect(router.state(first)?.failures).toBe(1)
    expect(router.infrastructureState(first)).toBeUndefined()
    expect(router.infrastructureSnapshot().size).toBe(0)
  })

  test("no available candidate yields undefined rather than a loop", () => {
    const router = MatrixRouter.make()
    const selection = router.select("fast", MatrixCatalog.CATALOG, () => false)
    expect(selection).toBeUndefined()
  })

  test("vision requirement resolves to a vision candidate", () => {
    const router = MatrixRouter.make()
    const candidates = [...MatrixCatalog.CATALOG, ...MatrixCatalog.VISION_CANDIDATES]
    const selection = router.select("vision", candidates, available)
    expect(selection).toBeDefined()
    expect(selection!.candidate.vision).toBe(true)
  })

  test("fallback ignores cooldown so the user can still progress", () => {
    const router = MatrixRouter.make()
    const first = MatrixCatalog.CATALOG[0]
    router.recordFailure(first, 100_000)
    const degraded = router.fallback("reliable", MatrixCatalog.CATALOG, available)
    expect(degraded).toBeDefined()
  })

  test("a cooling gateway does not hide the configured independent provider", () => {
    const router = MatrixRouter.make()
    for (const candidate of MatrixCatalog.RELIABLE_CANDIDATES)
      router.recordFailure(candidate, 120_000, { status: 503, message: "upstream unavailable" }, "infrastructure")
    const selection = router.select("reliable", mixedPool, available)
    expect(selection?.candidate.id).toBe("openrouter/free")
    expect(router.selectableCount("reliable", mixedPool, available)).toBe(1)
  })

  test("a disabled gateway route does not hide the configured independent provider", () => {
    const router = MatrixRouter.make()
    for (const candidate of MatrixCatalog.RELIABLE_CANDIDATES) router.disable(candidate, "model_not_supported")
    const selection = router.fallback("reliable", mixedPool, available)
    expect(selection?.candidate.id).toBe("openrouter/free")
  })
})
