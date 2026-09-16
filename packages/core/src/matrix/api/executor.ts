// Chat execution for the local OpenAI-compatible Matrix API.
//
// The preferred path is the local OmniRoute gateway's `auto/coding:free`
// policy. OmniRoute owns provider health, quota filtering and provider-level
// fallback; Matrix owns the logical models, recursion guard and route health.
// Direct free providers remain isolated from Free Auto and Vision. Reliable
// combines them with OmniRoute routes when their credentials are configured.
//
// `matrix-coding-reliable` falls back across the eligible pool without
// repeating a failed Matrix candidate.

import { Context, Effect, Layer, Option, Sink, Stream } from "effect"
import { randomUUID } from "node:crypto"
import {
  InvalidProviderOutputReason,
  LLM,
  LLMError,
  Message,
  type LLMEvent,
  type Model,
  ToolDefinition,
} from "@opencode-ai/llm"
import { OpenAICompatible } from "@opencode-ai/llm/providers"
import { LLMClient, Auth } from "@opencode-ai/llm/route"
import { MatrixCatalog } from "../catalog"
import { MatrixRouterService } from "../router-service"
import { MatrixRouter } from "../router"
import { MatrixReliable } from "../reliable"
import { MatrixLocalProvider } from "../local-provider"
import { MatrixProfile, type ProfileID } from "../profile"
import { type Settings } from "./config"
import { MatrixApiPool, type PoolEntry } from "./pool"
import { find, type MatrixModel } from "./models"
import { propagationHeaders } from "./recursion"
import * as ApiSchema from "./schema"
import {
  chatCompletionResponse,
  mapFinishReason,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type MatrixApiError,
} from "./schema"

export interface ChatCompletionInput {
  readonly request: ChatCompletionRequest
  readonly incomingHop: number
}

export type ChatCompletionResult =
  | { readonly stream: false; readonly response: ChatCompletionResponse }
  | { readonly stream: true; readonly response: Stream.Stream<string, MatrixApiError> }

// Secret-free routing snapshot for the status endpoint: last selected pool
// candidate and the candidates currently in cooldown / degraded health.
export interface RouteStatus {
  readonly lastSelected: string | null
  readonly preferredReliable: string | null
  readonly fallbackCandidates: ReadonlyArray<string>
  readonly candidates: ReadonlyArray<{
    readonly id: string
    readonly health: number
    readonly successes: number
    readonly failures: number
    readonly cooldownUntil: number
    readonly latencyMs?: number
    readonly disabledReason?: "model_not_supported" | "payment_required"
  }>
  readonly providers: {
    readonly omniroute: "available" | "unavailable"
    readonly openrouter: "configured" | "not configured"
    readonly cerebras: "configured" | "not configured"
    readonly ollama: "available" | "unavailable"
    readonly ollamaModels: number
    readonly independentInfrastructures: number
  }
}

export interface Executor {
  readonly settings: Settings
  readonly chatCompletion: (input: ChatCompletionInput) => Effect.Effect<ChatCompletionResult, MatrixApiError>
  readonly routeStatus: () => RouteStatus
}

export class Service extends Context.Service<Service, Executor>()("@opencode/Matrix/Api") {}

interface ExecutorContext {
  readonly settings: Settings
  readonly router: MatrixRouter.Router
  readonly eligible: readonly PoolEntry[]
  readonly reliableBase: readonly PoolEntry[]
  readonly local: { routes: readonly PoolEntry[] }
  readonly state: { lastSelected: string | undefined }
}

export function layer(settings: Settings) {
  return Layer.effect(
    Service,
    Effect.promise(async () => {
      const local = await MatrixLocalProvider.discover(ollamaDiscoveryOptions(settings))
      const resolved = MatrixApiPool.resolvePool(settings, settings.poolEnv)
      const override = MatrixApiPool.overrideEntry(settings)
      const omnirouteActive = settings.omnirouteBaseURL !== undefined && settings.directBaseURL === undefined
      const eligible = omnirouteActive
        ? [
            omnirouteEntry(settings.omnirouteBaseURL, "auto/coding:free"),
            omnirouteEntry(settings.omnirouteBaseURL, "opencode/mimo-v2.5-free"),
            ...MatrixCatalog.RELIABLE_CANDIDATES.map((candidate) => ({
              candidate,
              baseURL: settings.omnirouteBaseURL!,
              keyEnv: "OMNIROUTE_API_KEY",
              free: true,
              classification: "OMNIROUTE_BACKED" as const,
            })),
          ]
        : [
            ...resolved.free,
            ...(resolved.free.length === 0 && override?.classification === "DIRECT_AUTHENTICATED" ? [override] : []),
          ]
      const reliableBase = omnirouteActive
        ? [...eligible.filter((entry) => entry.candidate.profiles?.includes("reliable") === true), ...resolved.free]
        : eligible

      const ctx: ExecutorContext = {
        settings,
        router: MatrixRouter.make(),
        eligible,
        reliableBase,
        local: { routes: local },
        state: { lastSelected: undefined },
      }
      const chatCompletion = chatCompletionImpl(ctx) as Executor["chatCompletion"]
      const routeStatus = () => routeStatusImpl(ctx)
      return Service.of({ settings, chatCompletion, routeStatus })
    }),
  )
}

function omnirouteEntry(baseURL: string, model: "auto/coding:free" | "opencode/mimo-v2.5-free"): PoolEntry {
  return {
    candidate: [...MatrixCatalog.CATALOG, ...MatrixCatalog.VISION_CANDIDATES].find(
      (candidate) => candidate.model === model,
    )!,
    baseURL,
    keyEnv: "OMNIROUTE_API_KEY",
    free: true,
    classification: "OMNIROUTE_BACKED",
  }
}

const chatCompletionImpl = (ctx: ExecutorContext) =>
  Effect.fn("MatrixApi.chatCompletion")(function* (input: ChatCompletionInput) {
    const { settings } = ctx
    // Auth was already checked by the HTTP middleware; this is the durable
    // guard so the executor stays safe even when reused without the server.
    if (settings.apiKey === undefined) return yield* Effect.fail(ApiSchema.notConfigured())

    const hops = input.incomingHop
    if (hops >= settings.maxHops) return yield* Effect.fail(ApiSchema.hopLimitExceeded(hops))

    const model = find(input.request.model)
    if (model === undefined) return yield* Effect.fail(ApiSchema.modelNotFound(input.request.model))

    if (input.request.max_tokens !== undefined && input.request.max_tokens < 1)
      return yield* Effect.fail(ApiSchema.invalidRequest("max_tokens must be a positive integer", "invalid_max_tokens"))

    if (input.request.messages.length === 0)
      return yield* Effect.fail(
        ApiSchema.invalidRequest("messages must contain at least one message", "empty_messages"),
      )

    const hasImage = requestHasImage(input.request)
    if (hasImage && !requestImagesAreSupported(input.request))
      return yield* Effect.fail(
        ApiSchema.invalidRequest(
          "Image input must be a user-message inline PNG, JPEG, or WebP data URL.",
          "invalid_image_input",
        ),
      )
    if (hasImage && model.profile !== "vision")
      return yield* Effect.fail(
        ApiSchema.invalidRequest(
          `Model '${model.id}' does not guarantee image input. Select 'matrix-vision' so the image is preserved.`,
          "image_input_not_supported",
        ),
      )
    if (model.profile === "reliable") {
      ctx.local.routes = yield* Effect.promise(() => MatrixLocalProvider.discover(ollamaDiscoveryOptions(settings)))
    }
    const requiresTools = (input.request.tools?.length ?? 0) > 0
    const estimatedTokens = estimateRequestTokens(input.request)
    const candidates = toCandidates(model.profile === "reliable" ? reliableEntries(ctx) : ctx.eligible)
      .filter((candidate) => !hasImage || candidate.vision)
      .filter((candidate) => !requiresTools || candidate.toolCalls > 0)
      .filter((candidate) => candidate.context < 0 || estimatedTokens <= candidate.context)
    const selection = candidates.length === 0 ? undefined : ctx.router.select(model.profile, candidates, () => true)

    if (selection === undefined) return yield* Effect.fail(noFreeRouteError(ctx))

    if (model.profile === "reliable") return yield* runReliable(ctx, input, model, selection, hops)
    return yield* runSingleCoding(ctx, input, model, selection, hops)
  })

function toCandidates(entries: readonly PoolEntry[]) {
  return entries.map((entry) => entry.candidate)
}

function noFreeRouteError(ctx: ExecutorContext): MatrixApiError {
  if (MatrixApiPool.overrideEntry(ctx.settings)?.classification === "OMNIROUTE_BACKED") {
    return ApiSchema.recursionDetected(
      "Direct Matrix API route would loop back through the configured OmniRoute gateway.",
    )
  }
  return ApiSchema.noFreeRoute(
    `No free Matrix route is eligible (eligible: ${ctx.eligible.length}). Configure OmniRoute or an authenticated free direct provider.`,
  )
}

// ---------------------------------------------------------------------------
// Request plumbing
// ---------------------------------------------------------------------------

interface BuiltRequest {
  readonly upstream: Model
  readonly keyEnv: string
}

function buildUpstream(entry: PoolEntry, settings: Settings) {
  const apiKey = MatrixApiPool.credential(entry, settings, settings.poolEnv ?? process.env)
  const facade =
    apiKey === undefined
      ? OpenAICompatible.configure({ provider: "matrix-api", baseURL: entry.baseURL, auth: Auth.none })
      : OpenAICompatible.configure({ provider: "matrix-api", baseURL: entry.baseURL, apiKey })
  return { upstream: facade.model(entry.candidate.model), keyEnv: entry.keyEnv }
}

function buildRequest(input: ChatCompletionInput, model: MatrixModel, built: BuiltRequest, hops: number) {
  const { system, history } = splitMessages(input.request.messages)
  const generation = {
    ...(input.request.temperature === undefined ? {} : { temperature: input.request.temperature }),
    ...(input.request.max_tokens === undefined ? {} : { maxTokens: input.request.max_tokens }),
  }
  const tools = input.request.tools?.map((tool) =>
    ToolDefinition.make({
      name: tool.function.name,
      description: tool.function.description ?? "",
      inputSchema: (tool.function.parameters as Record<string, unknown>) ?? { type: "object", properties: {} },
    }),
  )
  const toolChoice =
    input.request.tool_choice === undefined
      ? undefined
      : typeof input.request.tool_choice === "string"
        ? input.request.tool_choice
        : input.request.tool_choice.function.name
  return LLM.request({
    model: built.upstream,
    system,
    messages: history,
    generation,
    tools: tools ?? [],
    ...(toolChoice === undefined ? {} : { toolChoice }),
    http: { headers: { ...propagationHeaders(hops), "x-opencode-retry-disabled": "true" } },
  })
}

type AttemptResult =
  | { readonly ok: true; readonly result: ChatCompletionResult; readonly latencyMs: number }
  | { readonly ok: false; readonly error: LLMError; readonly status: number; readonly retryAfterMs?: number }

class UpstreamAttemptFailure {
  readonly _tag = "UpstreamAttemptFailure"
  constructor(
    readonly error: LLMError,
    readonly status: number,
  ) {}
}

function runAttempt(
  ctx: ExecutorContext,
  input: ChatCompletionInput,
  model: MatrixModel,
  entry: PoolEntry,
  hops: number,
) {
  return Effect.gen(function* () {
    const { settings } = ctx
    const built = buildUpstream(entry, settings)
    const request = buildRequest(input, model, built, hops)
    const llm = yield* LLMClient.Service
    const startedAt = Date.now()

    if (input.request.stream) {
      const [firstOption, restStream] = yield* llm.stream(request).pipe(
        Stream.mapError((error) => new UpstreamAttemptFailure(error, upstreamStatus(error))),
        Stream.rechunk(1),
        Stream.peel(Sink.find<LLMEvent>(isReadyEvent)),
      )
      const first = Option.getOrUndefined(firstOption)
      if (first === undefined) return yield* Effect.fail(emptyStreamFailure())
      if (first.type === "provider-error") return yield* Effect.fail(providerEventFailure(first.message))
      const combinedStream = Stream.make(first).pipe(
        Stream.concat(restStream),
        Stream.mapError((failure) =>
          ApiSchema.upstreamFailure(MatrixRouterService.sanitizeMessage(failure.error.message), failure.status),
        ),
      )
      const id = `chatcmpl-${randomUUID()}`
      const created = Math.floor(Date.now() / 1000)
      const sseStream = combinedStream.pipe(
        Stream.mapEffect((event) => {
          if (event.type === "provider-error") return Effect.fail(ApiSchema.upstreamFailure(event.message))
          if (event.type === "text-delta") {
            const payload = {
              id,
              object: "chat.completion.chunk",
              created,
              model: input.request.model,
              choices: [
                {
                  index: 0,
                  delta: { content: event.text },
                  finish_reason: null,
                },
              ],
            }
            return Effect.succeed(`data: ${JSON.stringify(payload)}\n\n`)
          }
          if (event.type === "tool-call") {
            const payload = {
              id,
              object: "chat.completion.chunk",
              created,
              model: input.request.model,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: event.id,
                        type: "function",
                        function: {
                          name: event.name,
                          arguments: JSON.stringify(event.input),
                        },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            }
            return Effect.succeed(`data: ${JSON.stringify(payload)}\n\n`)
          }
          if (event.type === "tool-input-start") {
            const payload = {
              id,
              object: "chat.completion.chunk",
              created,
              model: input.request.model,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: event.id,
                        type: "function",
                        function: {
                          name: event.name,
                          arguments: "",
                        },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            }
            return Effect.succeed(`data: ${JSON.stringify(payload)}\n\n`)
          }
          if (event.type === "tool-input-delta") {
            const payload = {
              id,
              object: "chat.completion.chunk",
              created,
              model: input.request.model,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        function: {
                          arguments: event.text,
                        },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            }
            return Effect.succeed(`data: ${JSON.stringify(payload)}\n\n`)
          }
          if (event.type === "finish") {
            const finishReason = mapFinishReason(event.reason)
            const payload = {
              id,
              object: "chat.completion.chunk",
              created,
              model: input.request.model,
              choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
            }
            return Effect.succeed(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`)
          }
          return Effect.succeed("")
        }),
        Stream.filter((s) => s.length > 0),
      )

      return {
        ok: true as const,
        result: { stream: true as const, response: sseStream },
        latencyMs: Date.now() - startedAt,
      }
    }

    const response = yield* llm
      .generate(request)
      .pipe(Effect.mapError((error: LLMError) => new UpstreamAttemptFailure(error, upstreamStatus(error))))
    return {
      ok: true as const,
      latencyMs: Date.now() - startedAt,
      result: {
        stream: false as const,
        response: chatCompletionResponse({
          id: `chatcmpl-${randomUUID()}`,
          created: Math.floor(Date.now() / 1000),
          model: input.request.model,
          content: response.text,
          finishReason: mapFinishReason(response.finishReason),
          promptTokens: response.usage?.inputTokens,
          completionTokens: response.usage?.outputTokens,
          toolCalls: response.toolCalls.map((call) => ({ id: call.id, name: call.name, input: call.input })),
        }),
      },
    }
  }).pipe(
    Effect.catchTag("UpstreamAttemptFailure", (failure) =>
      Effect.succeed<AttemptResult>({
        ok: false as const,
        error: failure.error,
        status: failure.status,
        ...(failure.error.retryAfterMs === undefined ? {} : { retryAfterMs: failure.error.retryAfterMs }),
      }),
    ),
  )
}

function isReadyEvent(event: LLMEvent): boolean {
  return (
    event.type === "text-delta" ||
    event.type === "finish" ||
    event.type === "provider-error" ||
    event.type === "tool-call" ||
    event.type === "tool-input-start" ||
    event.type === "tool-input-delta" ||
    event.type === "tool-input-end"
  )
}

function emptyStreamFailure() {
  return providerEventFailure("Empty stream from upstream")
}

function providerEventFailure(message: string) {
  return new UpstreamAttemptFailure(
    new LLMError({
      module: "MatrixApi",
      method: "stream",
      reason: new InvalidProviderOutputReason({ message }),
    }),
    502,
  )
}

function onSuccess(
  ctx: ExecutorContext,
  entry: PoolEntry,
  profile: ProfileID,
  result: Extract<AttemptResult, { ok: true }>,
) {
  ctx.router.recordSuccess(entry.candidate, profile, result.latencyMs)
  ctx.state.lastSelected = entry.candidate.id
  return Effect.logInfo("Matrix route succeeded", {
    candidate: entry.candidate.id,
    provider: entry.candidate.provider,
    model: entry.candidate.model,
    latencyMs: result.latencyMs,
    action: "preferred",
  }).pipe(Effect.as(result.result))
}

// Record a provider failure into the router (only recoverable failures move
// health/cooldown; permanent ones are deliberately not recorded).
function onFailure(ctx: ExecutorContext, entry: PoolEntry, failure: Extract<AttemptResult, { ok: false }>) {
  const text = MatrixRouterService.sanitizeMessage(failure.error.message)
  const code = failure.status >= 400 && failure.status < 600 ? String(failure.status) : undefined
  const kind = MatrixReliable.classifyError(code, text)
  if (kind !== "none") {
    ctx.router.recordFailure(entry.candidate, COOLDOWN_MS[kind], {
      message: text,
      ...(code === undefined ? {} : { code }),
      status: failure.status,
    })
  }
  return Effect.fail(ApiSchema.upstreamFailure(text, failure.status))
}

// Cooldown after a recoverable provider failure, mirroring the values the
// routing service applies to its own catalog.
const COOLDOWN_MS: Readonly<Record<MatrixReliable.RecoverableKind, number>> = {
  retry: 30_000,
  fallback: 120_000,
  none: 0,
}

// ---------------------------------------------------------------------------
// matrix-coding: best-eligible selection with fallback across the pool
// ---------------------------------------------------------------------------

function runSingleCoding(
  ctx: ExecutorContext,
  input: ChatCompletionInput,
  model: MatrixModel,
  selection: MatrixRouter.Selection,
  hops: number,
) {
  const { router, eligible } = ctx
  let currentId = selection.candidate.id
  const attempted = new Set<string>()

  return Effect.gen(function* () {
    while (true) {
      const entry = entryFor(ctx, currentId)
      if (entry === undefined)
        return yield* Effect.fail(ApiSchema.noFreeRoute("Selected pool candidate is not available."))

      attempted.add(currentId)
      const result = yield* runAttempt(ctx, input, model, entry, hops)
      if (result.ok) return yield* onSuccess(ctx, entry, model.profile, result)

      const text = MatrixRouterService.sanitizeMessage(result.error.message)
      const code = result.status >= 400 && result.status < 600 ? String(result.status) : undefined
      const kind = MatrixReliable.classifyError(code, text)

      // Permanent errors on a single-candidate pool (e.g. Direct auth 401
      // with no other candidates): fail immediately.
      if (kind === "none") return yield* onFailure(ctx, entry, result)

      // Record the failure and try the next available candidate.
      router.recordFailure(entry.candidate, COOLDOWN_MS[kind], {
        message: text,
        ...(code === undefined ? {} : { code }),
        status: result.status,
      })

      const needsVision = requestHasImage(input.request)
      const others = toCandidates(eligible).filter(
        (candidate) => !attempted.has(candidate.id) && (!needsVision || candidate.vision),
      )
      const fallback = router.fallback(model.profile, others, () => true)
      if (fallback === undefined) return yield* onFailure(ctx, entry, result)

      currentId = fallback.candidate.id
    }
  })
}

// ---------------------------------------------------------------------------
// matrix-coding-reliable: fallback across the eligible pool
// ---------------------------------------------------------------------------

function runReliable(
  ctx: ExecutorContext,
  input: ChatCompletionInput,
  model: MatrixModel,
  first: MatrixRouter.Selection,
  hops: number,
) {
  return Effect.gen(function* () {
    const { settings, router } = ctx
    const reliableEligible = reliableEntries(ctx)
    const maxAttempts = Math.min(settings.maxAttempts, 3)
    let currentId = first.candidate.id
    let attempt = 0
    const attempted = new Set<string>()
    const attemptedInfrastructures = new Set<string>()

    while (true) {
      const entry = entryFor(ctx, currentId)
      if (entry === undefined)
        return yield* Effect.fail(ApiSchema.noFreeRoute("Selected pool candidate is not available."))
      attempt += 1
      attempted.add(currentId)
      attemptedInfrastructures.add(MatrixCatalog.infrastructureId(entry.candidate))

      const result = yield* runAttempt(ctx, input, model, entry, hops)
      if (result.ok) return yield* onSuccess(ctx, entry, model.profile, result)

      const text = MatrixRouterService.sanitizeMessage(result.error.message)
      const code = result.status >= 400 && result.status < 600 ? String(result.status) : undefined
      const disposition = MatrixReliable.classifyFailure(code, text)
      const error = {
        message: text,
        ...(code === undefined ? {} : { code }),
        status: result.status,
      }
      if (disposition === "request_invalid" || disposition === "permanent") return yield* onFailure(ctx, entry, result)

      const action =
        disposition === "model_not_supported"
          ? "disabled:model_not_supported"
          : disposition === "payment_required"
            ? "disabled:payment_required"
            : disposition === "authentication"
              ? "credential-switch"
              : "cooldown"
      if (disposition === "model_not_supported") router.disable(entry.candidate, "model_not_supported", error)
      if (disposition === "payment_required") router.disable(entry.candidate, "payment_required", error)
      if (disposition === "rate_limit")
        router.recordFailure(entry.candidate, Math.max(COOLDOWN_MS.retry, result.retryAfterMs ?? 0), error)
      if (disposition === "upstream_failure") router.recordFailure(entry.candidate, COOLDOWN_MS.fallback, error)
      yield* Effect.logWarning("Matrix reliable fallback", {
        candidate: entry.candidate.id,
        provider: entry.candidate.provider,
        model: entry.candidate.model,
        status: result.status,
        action,
        attempt,
        maxAttempts,
      })

      if (attempt >= maxAttempts) return yield* Effect.fail(ApiSchema.upstreamFailure(text, result.status))

      const needsVision = requestHasImage(input.request)
      const needsTools = (input.request.tools?.length ?? 0) > 0
      const estimatedTokens = estimateRequestTokens(input.request)
      const others = reliableEligible
        .filter((candidateEntry) => disposition !== "authentication" || candidateEntry.keyEnv !== entry.keyEnv)
        .map((candidateEntry) => candidateEntry.candidate)
        .filter(
          (candidate) =>
            !attempted.has(candidate.id) &&
            (!needsVision || candidate.vision) &&
            (!needsTools || candidate.toolCalls > 0) &&
            (candidate.context < 0 || estimatedTokens <= candidate.context),
        )
      const fallback = router.fallback(model.profile as ProfileID, others, () => true, attemptedInfrastructures)
      if (fallback === undefined) return yield* Effect.fail(ApiSchema.upstreamFailure(text, result.status))
      currentId = fallback.candidate.id
    }
  })
}

function entryFor(ctx: ExecutorContext, candidateId: string): PoolEntry | undefined {
  return [...ctx.eligible, ...reliableEntries(ctx)].find((entry) => entry.candidate.id === candidateId)
}

// ---------------------------------------------------------------------------
// Status snapshot
// ---------------------------------------------------------------------------

function routeStatusImpl(ctx: ExecutorContext): RouteStatus {
  const now = Date.now()
  const fallbackCandidates: string[] = []
  const candidates: RouteStatus["candidates"][number][] = []
  const reliableEligible = reliableEntries(ctx)
  const entries = [...ctx.eligible, ...reliableEligible].filter(
    (entry, index, all) => all.findIndex((candidate) => candidate.candidate.id === entry.candidate.id) === index,
  )
  for (const entry of entries) {
    const state = ctx.router.state(entry.candidate)
    if (state !== undefined && (state.cooldownUntil > now || state.health < 1)) {
      fallbackCandidates.push(entry.candidate.id)
    }
    if (state !== undefined) {
      candidates.push({
        id: entry.candidate.id,
        health: state.health,
        successes: state.successes,
        failures: state.failures,
        cooldownUntil: state.cooldownUntil,
        ...(state.latencyMs === undefined ? {} : { latencyMs: state.latencyMs }),
        ...(state.disabledReason === undefined ? {} : { disabledReason: state.disabledReason }),
      })
    }
  }
  const infrastructures = new Set(reliableEligible.map((entry) => MatrixCatalog.infrastructureId(entry.candidate)))
  return {
    lastSelected: ctx.state.lastSelected ?? null,
    preferredReliable: ctx.router.preferredCandidate("reliable") ?? null,
    fallbackCandidates,
    candidates,
    providers: {
      omniroute: ctx.settings.omnirouteBaseURL === undefined ? "unavailable" : "available",
      openrouter: ctx.settings.poolEnv?.OPENROUTER_API_KEY ? "configured" : "not configured",
      cerebras: ctx.settings.poolEnv?.CEREBRAS_API_KEY ? "configured" : "not configured",
      ollama: ctx.local.routes.length > 0 ? "available" : "unavailable",
      ollamaModels: ctx.local.routes.length,
      independentInfrastructures: infrastructures.size,
    },
  }
}

function estimateRequestTokens(request: ChatCompletionRequest): number {
  return Math.ceil(JSON.stringify(request).length / 4) + (request.max_tokens ?? 0)
}

function reliableEntries(ctx: ExecutorContext): readonly PoolEntry[] {
  return [
    ...ctx.reliableBase,
    ...ctx.local.routes.filter((entry) => entry.candidate.profiles?.includes("reliable") === true),
  ]
}

function ollamaDiscoveryOptions(settings: Settings) {
  return {
    ...(settings.ollamaBaseURL === undefined ? {} : { baseURL: settings.ollamaBaseURL }),
    ...(settings.ollamaCacheTtlMs === undefined ? {} : { ttlMs: settings.ollamaCacheTtlMs }),
  }
}

// ---------------------------------------------------------------------------
// Messages / helpers
// ---------------------------------------------------------------------------

function splitMessages(messages: ReadonlyArray<ChatCompletionRequest["messages"][number]>) {
  const system: string[] = []
  const history: Array<Message.Input> = []
  const toolNames = new Map<string, string>()
  for (const message of messages) {
    if (message.role === "system") {
      system.push(messageText(message))
      continue
    }
    if (message.role === "user") {
      history.push(Message.user(messageContent(message)))
      continue
    }
    if (message.role === "assistant") {
      const calls = (message.tool_calls ?? []).map((call) => {
        toolNames.set(call.id, call.function.name)
        return {
          type: "tool-call" as const,
          id: call.id,
          name: call.function.name,
          input: parseToolArguments(call.function.arguments),
        }
      })
      history.push(Message.assistant([...messageTextParts(message), ...calls]))
      continue
    }
    if (!message.tool_call_id) continue
    history.push(
      Message.tool({
        id: message.tool_call_id,
        name: message.name ?? toolNames.get(message.tool_call_id) ?? "tool",
        result: messageText(message),
        resultType: "text",
      }),
    )
  }
  return { system: system.join("\n\n"), history }
}

function messageTextParts(message: ChatCompletionRequest["messages"][number]) {
  const text = messageText(message)
  return text ? [Message.text(text)] : []
}

function parseToolArguments(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function requestHasImage(request: ChatCompletionRequest): boolean {
  return request.messages.some(
    (message) => Array.isArray(message.content) && message.content.some((part) => part.type === "image_url"),
  )
}

function requestImagesAreSupported(request: ChatCompletionRequest): boolean {
  return request.messages.every(
    (message) =>
      !Array.isArray(message.content) ||
      message.content.every(
        (part) =>
          part.type !== "image_url" ||
          (message.role === "user" &&
            /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(part.image_url.url)),
      ),
  )
}

function messageContent(message: ChatCompletionRequest["messages"][number]): Message.ContentInput {
  if (message.content === null || typeof message.content === "string") return message.content ?? ""
  return message.content.map((part) => {
    if (part.type === "text") return Message.text(part.text)
    const match = part.image_url.url.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/)
    if (!match) return Message.text("ERROR: Image must be an inline PNG, JPEG, or WebP data URL.")
    return { type: "media" as const, mediaType: match[1]!, data: match[2]! }
  })
}

function messageText(message: ChatCompletionRequest["messages"][number]): string {
  if (message.content === null) return ""
  if (typeof message.content === "string") return message.content
  return message.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("")
}

// Derive an HTTP status from the provider error when it carries one.
function upstreamStatus(error: LLMError): number {
  if ("status" in error.reason) return error.reason.status ?? 502
  if ("http" in error.reason && error.reason.http?.response !== undefined) return error.reason.http.response.status
  return 502
}

export { MatrixProfile }
export * as MatrixApiExecutor from "./executor"
