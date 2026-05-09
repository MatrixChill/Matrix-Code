import { Effect } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"

export class SchemaErrorMiddleware extends HttpApiMiddleware.Service<SchemaErrorMiddleware>()(
  "@opencode/ExperimentalHttpApiSchemaError",
) {}

export const schemaErrorLayer = HttpApiMiddleware.layerSchemaErrorTransform(SchemaErrorMiddleware, (error) => {
  if (error.kind === "Body") return Effect.fail(error)
  return Effect.succeed(
    HttpServerResponse.jsonUnsafe(
      {
        data: {},
        errors: [{ kind: error.kind, message: error.cause.message }],
        success: false,
      },
      { status: 400 },
    ),
  )
})
