import { MatrixRouterService } from "@opencode-ai/core/matrix/router-service"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"

export const matrixHandlers = HttpApiBuilder.group(InstanceHttpApi, "matrix", (handlers) =>
  Effect.gen(function* () {
    const matrix = yield* MatrixRouterService.Service
    return handlers.handle(
      "routing",
      Effect.fn("MatrixHttpApi.routing")(function* () {
        return matrix.snapshot()
      }),
    )
  }),
)