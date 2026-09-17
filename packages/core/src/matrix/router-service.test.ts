import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { MatrixCatalog } from "./catalog"
import { MatrixRouterService } from "./router-service"
import { MatrixRouter } from "./router"
import { MatrixReliable } from "./reliable"

const service = () =>
  Effect.gen(function* () {
    return yield* MatrixRouterService.Service
  }).pipe(Effect.provide(MatrixRouterService.layer))

const candidate = (snapshot: MatrixRouterService.RoutingSnapshot, provider: string, model: string) =>
  snapshot.candidates.find((c) => c.provider === provider && c.model === model)

const auto = (snapshot: MatrixRouterService.RoutingSnapshot) => candidate(snapshot, "omniroute", "auto")

const route = (id: string, infrastructureId: string, coding = 0.8): MatrixCatalog.Candidate => ({
  ...MatrixCatalog.RELIABLE_CANDIDATES[0]!,
  id,
  infrastructureId,
  coding,
})

describe("MatrixRouterService", () => {
  test("records an HTTP 500 failure", async () => {
    const svc = await Effect.runPromise(service())
    svc.recordFailure({
      providerID: "omniroute",
      modelID: "auto",
      message: "provider request failed",
      status: 500,
    })
    const state = auto(svc.snapshot())
    expect(state).toBeDefined()
    expect(state!.health).toBe(0.75)
    expect(state!.recentFailures).toBe(1)
    expect(state!.cooldownUntil).toBeGreaterThan(Date.now())
    expect(state!.lastError?.status).toBe(500)
    expect(state!.lastError?.code).toBe("500")
    expect(state!.lastError?.message).toBe("provider request failed")
  })

  test("records an HTTP 504 failure", async () => {
    const svc = await Effect.runPromise(service())
    svc.recordFailure({
      providerID: "omniroute",
      modelID: "auto",
      message: "gateway timed out",
      status: 504,
    })
    const state = auto(svc.snapshot())
    expect(state).toBeDefined()
    expect(state!.recentFailures).toBe(1)
    expect(state!.lastError?.status).toBe(504)
    expect(state!.lastError?.code).toBe("504")
  })

  test("records a timeout / network failure", async () => {
    const svc = await Effect.runPromise(service())
    svc.recordFailure({
      providerID: "omniroute",
      modelID: "auto",
      message: "HTTP transport failed: upstream request timeout",
      code: "Timeout",
    })
    const state = auto(svc.snapshot())
    expect(state).toBeDefined()
    expect(state!.recentFailures).toBe(1)
    expect(state!.lastError?.code).toBe("Timeout")
    expect(state!.cooldownUntil).toBeGreaterThan(Date.now())
  })

  test("sanitizes secret-looking metadata out of failure messages", async () => {
    const svc = await Effect.runPromise(service())
    svc.recordFailure({
      providerID: "omniroute",
      modelID: "auto",
      message:
        "upstream rejected token sk-abc1234567890secret and Bearer defghijklmnopqrstuvwxyz with api_key=live_12345678, status 500",
      status: 500,
    })
    const message = auto(svc.snapshot())!.lastError!.message
    expect(message).not.toContain("sk-abc")
    expect(message).not.toContain("Bearer defg")
    expect(message).not.toContain("live_1234")
    expect(message).toContain("[REDACTED]")
  })

  test("does not record permanent (auth) errors as provider health failures", async () => {
    const svc = await Effect.runPromise(service())
    svc.recordFailure({
      providerID: "omniroute",
      modelID: "auto",
      message: "authentication failed",
      status: 401,
    })
    const state = auto(svc.snapshot())
    expect(state).toBeUndefined()
  })

  test("records rate limit as a retry cooldown", async () => {
    const svc = await Effect.runPromise(service())
    svc.recordFailure({
      providerID: "omniroute",
      modelID: "auto",
      message: "rate limit exceeded",
      status: 429,
    })
    const state = auto(svc.snapshot())
    expect(state).toBeDefined()
    expect(state!.recentFailures).toBe(1)
    expect(state!.lastError?.status).toBe(429)
  })

  test("success doesn't create false failure data", async () => {
    const svc = await Effect.runPromise(service())
    const target = { providerID: "omniroute", modelID: "auto" }
    svc.recordSuccess(target)
    const state = auto(svc.snapshot())
    expect(state).toBeDefined()
    expect(state!.health).toBe(1)
    expect(state!.recentFailures).toBe(0)
    expect(state!.lastError).toBeUndefined()
    expect(state!.cooldownUntil).toBe(0)

    svc.recordFailure({ ...target, message: "server error", status: 500 })
    let recorded = auto(svc.snapshot())!
    expect(recorded.health).toBe(0.75)
    expect(recorded.recentFailures).toBe(1)

    svc.recordSuccess(target)
    recorded = auto(svc.snapshot())!
    expect(recorded.health).toBe(0.85)
    expect(recorded.recentFailures).toBe(0)
    expect(recorded.lastError).toBeUndefined()
  })

  test("snapshot round-trips candidate identity", async () => {
    const svc = await Effect.runPromise(service())
    svc.recordFailure({
      providerID: "omniroute",
      modelID: "auto",
      message: "server error",
      status: 500,
    })
    const state = auto(svc.snapshot())!
    expect(state.id).toBe("omniroute/matrix-auto")
    expect(state.provider).toBe("omniroute")
    expect(state.model).toBe("auto")
  })
})

describe("MatrixRouter fallback", () => {
  test("prefers a different infrastructure after an infrastructure failure", () => {
    const router = MatrixRouter.make(() => 1_000)
    const failed = route("route/a", "shared", 1)
    const same = route("route/b", "shared", 1)
    const diverse = route("route/c", "independent", 0.1)

    router.recordFailure(failed, 30_000, { message: "backend unavailable", status: 503 }, "infrastructure")

    expect(router.fallback("reliable", [same, diverse], () => true)?.candidate.id).toBe(diverse.id)
  })

  test("uses the same infrastructure when no diverse route exists", () => {
    const router = MatrixRouter.make(() => 1_000)
    const failed = route("route/a", "shared")
    const same = route("route/b", "shared")

    router.recordFailure(failed, 30_000, { message: "backend unavailable", status: 503 }, "infrastructure")

    expect(router.fallback("reliable", [same], () => true)?.candidate.id).toBe(same.id)
  })

  test("route failure does not degrade a sibling route infrastructure", () => {
    const router = MatrixRouter.make(() => 1_000)
    const failed = route("route/a", "shared")
    const sibling = route("route/b", "shared")

    router.recordFailure(failed, 30_000, { message: "model not supported", status: 401 }, "route")

    expect(router.infrastructureState(sibling)).toBeUndefined()
    expect(router.fallback("reliable", [sibling], () => true)?.candidate.id).toBe(sibling.id)
  })

  test("infrastructure degradation affects all routes on that infrastructure", () => {
    const router = MatrixRouter.make(() => 1_000)
    const failed = route("route/a", "shared")
    const sibling = route("route/b", "shared")
    const independent = route("route/c", "independent")

    router.recordFailure(failed, 30_000, { message: "upstream timeout", status: 504 }, "infrastructure")

    expect(router.infrastructureHealth(sibling)).toBe(0.5)
    expect(router.select("reliable", [sibling, independent], () => true)?.candidate.id).toBe(independent.id)
  })

  test("infrastructure degradation expires after its cooldown", () => {
    let now = 1_000
    const router = MatrixRouter.make(() => now)
    const target = route("route/a", "shared")

    router.recordFailure(target, 5_000, { message: "backend unavailable", status: 503 }, "infrastructure")
    expect(router.infrastructureHealth(target)).toBe(0.5)

    now = 6_001
    expect(router.infrastructureHealth(target)).toBe(1)
    expect(router.infrastructureState(target)?.health).toBe(0.75)
  })

  test("stickiness recovers after infrastructure cooldown", () => {
    let now = 1_000
    const router = MatrixRouter.make(() => now)
    const preferred = route("route/a", "shared")
    const failedSibling = route("route/b", "shared")
    const independent = route("route/c", "independent")

    router.recordSuccess(preferred, "reliable", 20)
    router.recordFailure(
      failedSibling,
      5_000,
      { message: "backend unavailable", status: 503 },
      "infrastructure",
    )
    expect(router.select("reliable", [preferred, independent], () => true)?.candidate.id).toBe(independent.id)

    now = 6_001
    expect(router.select("reliable", [preferred, independent], () => true)?.candidate.id).toBe(preferred.id)
  })

  test("credential and request failures do not degrade route or infrastructure", () => {
    const router = MatrixRouter.make(() => 1_000)
    const target = route("route/a", "shared")

    router.recordFailure(target, 30_000, { message: "invalid API key", status: 401 }, "credential")
    router.recordFailure(target, 30_000, { message: "invalid payload", status: 400 }, "request")

    expect(router.state(target)).toBeUndefined()
    expect(router.infrastructureState(target)).toBeUndefined()
  })

  test("429 cools only the route for the supplied Retry-After duration", () => {
    const router = MatrixRouter.make(() => 1_000)
    const target = route("route/a", "shared")

    router.recordFailure(target, 120_000, { message: "rate limit", status: 429 }, "route")

    expect(router.state(target)?.cooldownUntil).toBe(121_000)
    expect(router.infrastructureState(target)).toBeUndefined()
  })

  test.each([
    ["503", "backend unavailable"],
    [undefined, "upstream request timeout"],
  ] as const)("%s infrastructure failure permits diverse fallback", (code, message) => {
    const router = MatrixRouter.make(() => 1_000)
    const failed = route("route/a", "shared")
    const diverse = route("route/b", "independent")
    const disposition = MatrixReliable.classifyFailure(code, message)

    expect(MatrixReliable.failureScope(disposition)).toBe("infrastructure")
    router.recordFailure(failed, 30_000, { message, ...(code === undefined ? {} : { status: Number(code) }) }, "infrastructure")
    expect(router.fallback("reliable", [diverse], () => true)?.candidate.id).toBe(diverse.id)
  })

  test("failure dispositions preserve route, credential, and request scopes", () => {
    expect(MatrixReliable.failureScope(MatrixReliable.classifyFailure("401", "model not supported"))).toBe("route")
    expect(MatrixReliable.failureScope(MatrixReliable.classifyFailure("401", "invalid API key"))).toBe("credential")
    expect(MatrixReliable.failureScope(MatrixReliable.classifyFailure("400", "invalid payload"))).toBe("request")
    expect(MatrixReliable.failureScope(MatrixReliable.classifyFailure("429", "rate limit"))).toBe("route")
  })

  test("recognizes OpenCode external-use restriction as infrastructure-wide", () => {
    const disposition = MatrixReliable.classifyFailure(
      "403",
      "OpenCode's free tier can only be used from within OpenCode",
    )
    expect(disposition).toBe("restricted_external_route")
    expect(MatrixReliable.failureScope(disposition)).toBe("infrastructure")
  })

  test("select and fallback both skip a cooling candidate", async () => {
    const svc = await Effect.runPromise(service())
    svc.recordFailure({
      providerID: "omniroute",
      modelID: "matrix/matrix-coding-reliable",
      message: "gateway timeout",
      status: 504,
    })
    const router = MatrixRouter.make()
    router.restore(
      new Map(
        svc
          .snapshot()
          .candidates.map((state) => [
            state.id,
            {
              health: state.health,
              cooldownUntil: state.cooldownUntil,
              recentFailures: state.recentFailures,
              successes: state.successes,
              failures: state.failures,
              ...(state.lastError === undefined
                ? {}
                : {
                    lastError: {
                      message: state.lastError.message,
                      code: state.lastError.code,
                      status: state.lastError.status,
                      at: state.lastError.at,
                    },
                  }),
            },
          ]),
      ),
    )
    const profile = "reliable"
    const available = () => true
    const selected = router.select(profile, MatrixCatalog.CATALOG, available)
    expect(selected?.candidate.model).not.toBe("matrix/matrix-coding-reliable")
    const fallback = router.fallback(profile, MatrixCatalog.CATALOG, available)
    expect(fallback?.candidate.model).not.toBe("matrix/matrix-coding-reliable")
  })

  test("successful candidate becomes sticky and records latency", () => {
    const now = () => 1_000
    const router = MatrixRouter.make(now)
    const candidates = MatrixCatalog.RELIABLE_CANDIDATES
    const initial = router.select("reliable", candidates, () => true)!.candidate
    const alternate = candidates.find((entry) => entry.id !== initial.id)!

    router.recordSuccess(alternate, "reliable", 120)
    router.recordSuccess(alternate, "reliable", 80)

    expect(router.select("reliable", candidates, () => true)?.candidate.id).toBe(alternate.id)
    expect(router.preferredCandidate("reliable")).toBe(alternate.id)
    expect(router.state(alternate)).toMatchObject({ successes: 2, failures: 0, latencyMs: 108 })
  })

  test("cooldown and disabled candidates stay out of selection", () => {
    let now = 1_000
    const router = MatrixRouter.make(() => now)
    const candidates = MatrixCatalog.RELIABLE_CANDIDATES
    const first = router.select("reliable", candidates, () => true)!.candidate
    router.recordFailure(first, 5_000, { message: "rate limited", status: 429 })
    expect(router.select("reliable", candidates, () => true)?.candidate.id).not.toBe(first.id)

    now = 6_001
    expect(router.select("reliable", candidates, () => true)?.candidate.id).toBe(first.id)
    router.disable(first, "model_not_supported", { message: "unsupported model", status: 401 })
    expect(router.select("reliable", candidates, () => true)?.candidate.id).not.toBe(first.id)
    expect(router.state(first)?.disabledReason).toBe("model_not_supported")
  })
})
