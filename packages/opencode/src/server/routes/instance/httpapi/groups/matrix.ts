import { MatrixRouterService } from "@opencode-ai/core/matrix/router-service"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { described } from "./metadata"

export const MatrixPaths = {
  routing: "/matrix/routing",
} as const

export const MatrixApi = HttpApi.make("matrix").add(
  HttpApiGroup.make("matrix")
    .add(
      HttpApiEndpoint.get("routing", MatrixPaths.routing, {
        success: described(MatrixRouterService.RoutingSnapshot, "Matrix router state"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "matrix.routing",
          summary: "Get Matrix router state",
          description:
            "Snapshot of Matrix router candidate health, cooldowns, and the most recent real request failures.",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "matrix", description: "Matrix router status routes." }))
    .middleware(Authorization),
)