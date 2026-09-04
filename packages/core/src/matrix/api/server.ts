// HTTP server for the local OpenAI-compatible Matrix API.
//
// All endpoints live under `/v1`, bound to loopback only. Authorization is a
// Bearer token compared in constant time; the key never leaves config.ts and
// never appears in logs or responses. Chat completions route through the
// executor, which enforces the recursion guards (structural route selection +
// the hop/origin header chain).

import { NodeHttpServer } from "@effect/platform-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Effect, Exit, Layer, MutableRef, Option, Scope } from "effect"
import { createHash, timingSafeEqual } from "node:crypto"
import { createServer } from "node:http"
import { Headers, HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { status, type Settings } from "./config"
import { layer as executorLayer, Service as ExecutorService } from "./executor"
import { listPayload } from "./models"
import { HOP_HEADER, parseHop } from "./recursion"
import * as ApiSchema from "./schema"
import { type MatrixApiError } from "./schema"

export interface MatrixApiListener {
  readonly url: string
  readonly port: number
  readonly host: string
  readonly stop: Effect.Effect<void>
}

type Effective = { readonly url: string; readonly port: number }

// Bind the API to the settings address, scoped to the provided scope so it
// shuts down together with its owner. Errors (e.g. address in use) surface to
// the caller, which decides whether to fall back.
export function start(settings: Settings, scope: Scope.Scope): Effect.Effect<MatrixApiListener, unknown> {
  return Effect.gen(function* () {
    const effective = MutableRef.make<Effective>({ url: "", port: settings.port })
    const context = yield* Layer.buildWithMemoMap(
      serverLayer(settings, effective),
      Layer.makeMemoMapUnsafe(),
      scope,
    ).pipe(Effect.provide(Context.makeUnsafe<unknown>(new Map())))
    const server = Context.get(context, HttpServer.HttpServer)
    const address = server.address
    if (address._tag !== "TcpAddress")
      return yield* Effect.die(new Error(`Unexpected Matrix API server address tag: ${address._tag}`))
    const port = address.port
    const url = `http://${settings.host}:${port}`
    MutableRef.set(effective, { url, port })
    return {
      url,
      port,
      host: settings.host,
      stop: Scope.close(scope, Exit.void).pipe(Effect.ignore),
    }
  })
}

// Scoped variant for standalone use: the returned listener owns its scope and
// `stop` closes it.
export function listen(settings: Settings): Effect.Effect<MatrixApiListener, unknown, Scope.Scope> {
  return Effect.gen(function* () {
    const scope = yield* Effect.scope
    return yield* start(settings, scope)
  })
}

function serverLayer(settings: Settings, effective: MutableRef.MutableRef<Effective>) {
  return HttpRouter.serve(routerLayer(settings, effective), { disableListenLog: true, disableLogger: true }).pipe(
    Layer.provideMerge(executorLayer(settings)),
    Layer.provideMerge(
      NodeHttpServer.layer(() => createServer(), {
        port: settings.port,
        host: settings.host,
        gracefulShutdownTimeout: "1 second",
      }),
    ),
    Layer.provide(
      AppNodeBuilder.build(
        LayerNode.group([LayerNodePlatform.llmClient, LayerNodePlatform.requestExecutor, LayerNodePlatform.httpClient]),
      ),
    ),
  )
}

function routerLayer(settings: Settings, effective: MutableRef.MutableRef<Effective>) {
  return Layer.mergeAll(
    HttpRouter.add("GET", "/v1/models", modelsHandler(settings)),
    HttpRouter.add("GET", "/v1/status", statusHandler(settings, effective)),
    HttpRouter.add("POST", "/v1/chat/completions", chatHandler(settings)),
    HttpRouter.add("*", "/*", notFoundHandler(settings)),
  )
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function modelsHandler(settings: Settings) {
  return (request: HttpServerRequest.HttpServerRequest) =>
    authorizedOr(request, settings, () => HttpServerResponse.jsonUnsafe(listPayload()))
}

function statusHandler(settings: Settings, effective: MutableRef.MutableRef<Effective>) {
  return (request: HttpServerRequest.HttpServerRequest) =>
    authorizedOr(request, settings, () => {
      const base = status(settings)
      const bound = MutableRef.get(effective)
      return HttpServerResponse.jsonUnsafe({ ...base, effectiveURL: bound.url, effectivePort: bound.port })
    })
}

function chatHandler(settings: Settings) {
  return Effect.fn("MatrixApi.chatHandler")((request: HttpServerRequest.HttpServerRequest) =>
    Effect.gen(function* () {
      const authError = yield* guardAuth(request, settings)
      if (authError !== undefined) return yield* apiErrorResponse(authError)

      const body = yield* HttpServerRequest.schemaBodyJson(ApiSchema.ChatCompletionRequest).pipe(
        Effect.match({
          onFailure: () => undefined,
          onSuccess: (value) => value,
        }),
      )
      if (body === undefined)
        return yield* apiErrorResponse(ApiSchema.invalidRequest("Malformed chat completion request body.", "invalid_json"))

      const executor = yield* ExecutorService
      return yield* executor
        .chatCompletion({ request: body, incomingHop: parseHop(getHeader(request, HOP_HEADER)) })
        .pipe(
          Effect.map((value) => HttpServerResponse.jsonUnsafe(value)),
          Effect.catch((error) => apiErrorResponse(error)),
        )
    }),
  )
}

function notFoundHandler(settings: Settings) {
  return (request: HttpServerRequest.HttpServerRequest) =>
    authorizedOr(request, settings, () =>
      HttpServerResponse.jsonUnsafe(
        new ApiSchema.MatrixApiError(
          404,
          "invalid_request_error",
          "Unknown Matrix API route. See GET /v1/models and POST /v1/chat/completions.",
        ).body,
        { status: 404 },
      ),
    )
}

// Run `next` only when the request is authorized; otherwise short-circuit with
// the structured error response.
function authorizedOr(
  request: HttpServerRequest.HttpServerRequest,
  settings: Settings,
  next: () => HttpServerResponse.HttpServerResponse,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, never> {
  return guardAuth(request, settings).pipe(
    Effect.flatMap((error) => (error === undefined ? Effect.sync(next) : apiErrorResponse(error))),
  )
}

// Returns a pending MatrixApiError when the request is not authorized, or
// undefined when it may proceed. The executor re-checks the durable guard
// independently of this HTTP layer.
function guardAuth(
  request: HttpServerRequest.HttpServerRequest,
  settings: Settings,
): Effect.Effect<MatrixApiError | undefined, never, never> {
  const apiKey = settings.apiKey
  if (apiKey === undefined) return Effect.succeed(ApiSchema.notConfigured())
  const token = Headers.get("authorization")(request.headers).pipe(
    Option.filter((value) => value.startsWith("Bearer ")),
    Option.map((value) => value.slice("Bearer ".length).trim()),
  )
  const matches = token.pipe(Option.exists((value) => safeEqual(value, apiKey)))
  if (!matches) return Effect.succeed(ApiSchema.authenticationFailed())
  return Effect.succeed(undefined)
}

const apiErrorResponse = (
  error: MatrixApiError,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, never> =>
  Effect.succeed(
    HttpServerResponse.jsonUnsafe(error.body, {
      status: error.status,
      headers: { "x-matrix-error": error.code ?? error.type },
    }),
  )

function getHeader(request: HttpServerRequest.HttpServerRequest, name: string): string | undefined {
  return Option.getOrUndefined(Headers.get(name)(request.headers))
}

function safeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest()
  const right = createHash("sha256").update(b).digest()
  return timingSafeEqual(left, right)
}

export * as MatrixApiServer from "./server"