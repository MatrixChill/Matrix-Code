import { describe, expect, test } from "bun:test"
import { MatrixRouter } from "@opencode-ai/core/matrix/router"
import { MatrixCatalog } from "@opencode-ai/core/matrix/catalog"
import { MatrixProfile, LABELS, PROFILE_IDS } from "@opencode-ai/core/matrix/profile"

const available = (candidate: MatrixCatalog.Candidate) => !candidate.id.includes("offline")

describe("MatrixProfile", () => {
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
})
