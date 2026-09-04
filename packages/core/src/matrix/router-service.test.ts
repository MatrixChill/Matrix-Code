import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { MatrixCatalog } from "./catalog"
import { MatrixRouterService } from "./router-service"
import { MatrixRouter } from "./router"

const service = () =>
  Effect.gen(function* () {
    return yield* MatrixRouterService.Service
  }).pipe(Effect.provide(MatrixRouterService.layer))

const candidate = (snapshot: MatrixRouterService.RoutingSnapshot, provider: string, model: string) =>
  snapshot.candidates.find((c) => c.provider === provider && c.model === model)

const auto = (snapshot: MatrixRouterService.RoutingSnapshot) => candidate(snapshot, "omniroute", "auto")

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
  test("select skips a failed candidate while degrade-fallback still returns it", async () => {
    const svc = await Effect.runPromise(service())
    svc.recordFailure({
      providerID: "omniroute",
      modelID: "matrix-free-coding",
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
    expect(selected?.candidate.model).not.toBe("matrix-free-coding")
    const fallback = router.fallback(profile, MatrixCatalog.CATALOG, available)
    expect(fallback?.candidate.model).toBe("matrix-free-coding")
  })
})