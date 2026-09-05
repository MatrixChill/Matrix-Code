import { Effect } from "effect"
import { effectCmd, fail } from "../effect-cmd"
import { MatrixApiConfig } from "@opencode-ai/core/matrix/api/config"
import { MatrixApiServer } from "@opencode-ai/core/matrix/api/server"

// Headless owner of the local Matrix API, used by the Windows launcher to keep
// port 20260 alive as an independent service: reuse-if-active, start-if-needed,
// readiness poll, then targeted shutdown. Mirrors the fail-closed contract of
// `MatrixApiConfig` — without MATRIX_API_ENABLED and MATRIX_API_KEY this exits
// non-zero rather than serving unauthenticated traffic.
export const MatrixApiCommand = effectCmd({
  command: "matrix-api",
  describe: "starts only the local Matrix API (used by the Windows launcher)",
  // No project state involved: pure network service from environment config.
  instance: false,
  handler: Effect.fn("Cli.matrixApi")(function* () {
    const settings = MatrixApiConfig.fromEnv()
    if (!MatrixApiConfig.isConfigured(settings)) {
      return yield* fail(
        "Matrix API is disabled or missing MATRIX_API_KEY; nothing to serve (fail closed).",
      )
    }
    // The scope stays open for as long as the effect below blocks, so the
    // listener keeps serving until the process is interrupted.
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const listener = yield* MatrixApiServer.listen(settings).pipe(Effect.orDie)
        console.log(`matrix api listening on ${listener.url}`)
        yield* Effect.never
      }),
    )
  }),
})