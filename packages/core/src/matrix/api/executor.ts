// Chat execution for the local OpenAI-compatible Matrix API.
//
// The preferred path is the local OmniRoute gateway's `auto/coding:free`
// policy. OmniRoute owns provider health, quota filtering and provider-level
// fallback; Matrix owns the logical models, recursion guard and route health.
// Free Auto prefers the bundled OmniRoute free path and keeps the configured
// direct free providers eligible as its fallback. Vision stays isolated to the
// OmniRoute vision candidate. Reliable combines both pools when their
// credentials are configured.
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
  // Preferred first-choice pool for Free Auto: the bundled OmniRoute free path.
  // Empty when OmniRoute is not active, so selection falls through to `eligible`.
  readonly preferredFree: readonly PoolEntry[]
  // Pool every profile uses, unchanged: OmniRoute-backed candidates only when
  // the gateway is active.
  readonly eligible: readonly PoolEntry[]
  // Free Auto's pool admits only entries explicitly marked free.
  readonly freeAutoEligible: readonly PoolEntry[]
  readonly reliableBase: readonly PoolEntry[]
  readonly local: { routes: readonly PoolEntry[] }
  readonly state: { lastSelected: string | undefined }
  // Process-scoped record of provider credentials whose daily/account allowance
  // is spent. Keyed by provider+credential — the narrowest identity the pool
  // has, and the same pair `credentialScope` derives below. It groups
  // openrouter/free with openrouter/nemotron-3-ultra-free, which share
  // OPENROUTER_API_KEY, while keeping Cerebras, each gateway-backed provider,
  // the authenticated override and the local routes in their own scopes.
  // Deliberately not router state — a spent allowance is neither an
  // infrastructure outage nor a permanently invalid credential — and
  // deliberately not persisted, so a new Matrix process starts clean instead of
  // guessing a provider reset time.
  readonly quotaExhausted: Set<string>
}

export function layer(settings: Settings) {
  return Layer.effect(
    Service,
    Effect.promise(async () => {
      const local = await MatrixLocalProvider.discover(ollamaDiscoveryOptions(settings))
      const resolved = MatrixApiPool.resolvePool(settings, settings.poolEnv)
      const override = MatrixApiPool.overrideEntry(settings)
      const freeAuto = freeAutoPool(settings, resolved, override)
      const eligible = freeAuto.shared
      // The explicit authenticated override is the documented fallback for an
      // empty free/direct pool, and only for that case. It is deliberately kept
      // out of Free Auto, so a paid route never enters the free-only pool.
      const overrideFallback =
        resolved.free.length === 0 && override?.classification === "DIRECT_AUTHENTICATED" ? [override] : []
      // Reliable combines the gateway's Reliable candidates with every
      // independent direct provider. OmniRoute's membership here is decided by
      // OMNIROUTE_BASE_URL alone: configuring MATRIX_API_DIRECT_BASE_URL adds a
      // fallback route, it does not delete another infrastructure's routes.
      const reliableBase = dedupeEntries([
        ...freeAuto.omnirouteReliable,
        ...resolved.free,
        ...overrideFallback,
      ])

      const ctx: ExecutorContext = {
        settings,
        router: MatrixRouter.make(),
        preferredFree: freeAuto.preferred,
        eligible,
        freeAutoEligible: freeAuto.eligible,
        reliableBase,
        local: { routes: local },
        state: { lastSelected: undefined },
        quotaExhausted: new Set<string>(),
      }
      const chatCompletion = chatCompletionImpl(ctx) as Executor["chatCompletion"]
      const routeStatus = () => routeStatusImpl(ctx)
      return Service.of({ settings, chatCompletion, routeStatus })
    }),
  )
}

export interface FreeAutoPool {
  // First-choice pool: the bundled OmniRoute free candidates. Empty when
  // OmniRoute is not active, so Free Auto scores the whole pool directly.
  readonly preferred: readonly PoolEntry[]
  // Free Auto's pool: the preferred routes first, then the remaining
  // OmniRoute-backed free candidates, then the configured DIRECT_FREE routes.
  readonly eligible: readonly PoolEntry[]
  // The pool every other profile keeps using. Vision in particular must stay on
  // the proven OmniRoute vision candidate, so the direct free routes are not
  // added here.
  readonly shared: readonly PoolEntry[]
  // The gateway-backed Reliable candidates, present whenever OMNIROUTE_BASE_URL
  // is configured. Exposed separately because Free Auto's own pool shape also
  // depends on whether a direct route is configured, while Reliable's must not:
  // configuring a direct fallback may add a route, never delete another
  // infrastructure's routes.
  readonly omnirouteReliable: readonly PoolEntry[]
}

// The gateway-backed Reliable candidates. Membership is decided by
// OMNIROUTE_BASE_URL alone — a configured MATRIX_API_DIRECT_BASE_URL is a
// separate fallback path and must not remove these from the Reliable pool.
function omnirouteReliableEntries(settings: Settings): readonly PoolEntry[] {
  const baseURL = settings.omnirouteBaseURL
  if (baseURL === undefined) return []
  return MatrixCatalog.RELIABLE_CANDIDATES.map((candidate) => ({
    candidate,
    baseURL,
    keyEnv: "OMNIROUTE_API_KEY",
    free: true,
    classification: "OMNIROUTE_BACKED" as const,
  }))
}

// Free Auto's pool. The bundled OmniRoute free path is preferred; the remaining
// OmniRoute-backed free candidates and the configured DIRECT_FREE routes
// (OpenRouter/Cerebras, present only when their credential exists) stay in the
// same pool as fallbacks, so a restrictive OmniRoute upstream no longer strands
// Free Auto with no candidate at all. Check the explicit free metadata at this
// boundary rather than trusting a pool name or classification. The shared pool
// retains authenticated overrides for other profiles.
export function freeAutoPool(
  settings: Settings,
  resolved: MatrixApiPool.ResolvedPool,
  override: PoolEntry | undefined = MatrixApiPool.overrideEntry(settings),
): FreeAutoPool {
  const omnirouteReliable = omnirouteReliableEntries(settings)
  if (settings.omnirouteBaseURL === undefined || settings.directBaseURL !== undefined) {
    const shared = [
      ...resolved.free,
      ...(resolved.free.length === 0 && override?.classification === "DIRECT_AUTHENTICATED" ? [override] : []),
    ]
    return { preferred: [], eligible: shared.filter((entry) => entry.free === true), shared, omnirouteReliable }
  }
  const baseURL = settings.omnirouteBaseURL
  const preferred = [
    omnirouteEntry(baseURL, "auto/coding:free"),
    omnirouteEntry(baseURL, "opencode/mimo-v2.5-free"),
  ].filter((entry) => entry.free === true)
  const shared = [...preferred, ...omnirouteReliable]
  return {
    preferred,
    eligible: dedupeEntries([...shared, ...resolved.free].filter((entry) => entry.free === true)),
    shared,
    omnirouteReliable,
  }
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

    // A direct route pointed back at the configured gateway is a loop, not a
    // fallback. Refused structurally before any pool is consulted, so the guard
    // holds for every profile no matter which pools a route would otherwise
    // reach through — including the Reliable pool, which keeps the gateway's own
    // candidates even while a direct route is configured.
    if (MatrixApiPool.overrideEntry(settings)?.classification === "OMNIROUTE_BACKED")
      return yield* Effect.fail(
        ApiSchema.recursionDetected(
          "Direct Matrix API route would loop back through the configured OmniRoute gateway.",
        ),
      )

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
    const usable = (candidate: MatrixCatalog.Candidate) =>
      (!hasImage || candidate.vision) &&
      (!requiresTools || candidate.toolCalls > 0) &&
      (candidate.context < 0 || estimatedTokens <= candidate.context)
    // Free Auto alone may reach the configured direct free providers; every
    // other profile keeps the OmniRoute-only pool.
    const pool = model.profile === "free" ? ctx.freeAutoEligible : ctx.eligible
    // The reliable profile ranks its own entry set, so the entries actually
    // considered are tracked separately: reporting `pool` there is what made
    // the no-route error count entries that were never candidates.
    const entries = model.profile === "reliable" ? reliableEntries(ctx) : pool
    // A credential whose provider allowance is already spent is dropped from
    // selection, not only from the fallback set: the point of detecting the
    // exhaustion is to reach an independent provider immediately instead of
    // spending another call on a route that cannot answer.
    const available = entries.filter((entry) => !quotaExhaustedFor(ctx, entry))
    const candidates = toCandidates(available).filter(usable)
    // Free Auto only: pick from the preferred OmniRoute free pool first and let
    // scoring order it. Ranking the whole pool at once would let a
    // higher-scoring direct free route (Cerebras' speed weighting) outrank
    // OmniRoute on the very first attempt, which is not the intended policy.
    const preferred =
      model.profile === "free"
        ? toCandidates(ctx.preferredFree)
            .filter(usable)
            .filter((candidate) => candidates.some((entry) => entry.id === candidate.id))
        : []
    const selection =
      candidates.length === 0
        ? undefined
        : (ctx.router.select(model.profile, preferred, () => true) ??
          ctx.router.select(model.profile, candidates, () => true))

    if (selection === undefined)
      return yield* Effect.fail(
        noFreeRouteError(ctx, {
          pool: entries.length,
          compatible: candidates.length,
          selectable: ctx.router.selectableCount(model.profile, candidates, () => true),
          exhaustedCredentials: exhaustedCredentialCount(ctx, entries),
        }),
      )

    if (model.profile === "reliable") return yield* runReliable(ctx, input, model, selection, hops, usable)
    return yield* runSingleCoding(ctx, input, model, selection, hops, pool, usable)
  })

function toCandidates(entries: readonly PoolEntry[]) {
  return entries.map((entry) => entry.candidate)
}

// Free Auto's pool merges the OmniRoute-backed candidates with the configured
// direct free routes, and a candidate can legitimately appear in both lists —
// the pool must never offer the router two entries with the same candidate id.
function dedupeEntries(entries: readonly PoolEntry[]): PoolEntry[] {
  const seen = new Set<string>()
  return entries.filter((entry) => {
    if (seen.has(entry.candidate.id)) return false
    seen.add(entry.candidate.id)
    return true
  })
}

// The counts are the three stages that decide routing, so an operator can tell
// a pool with nothing compatible in it (context/vision/tool requirements) from
// a pool whose candidates are all cooling down or disabled. A bare pool size
// reads as "six routes were eligible" when none of them was selectable.
interface NoRouteCounts {
  readonly pool: number
  readonly compatible: number
  readonly selectable: number
  // Distinct provider credentials in the pool whose allowance is already spent
  // for this process, so "no route" can name the real cause instead of
  // reporting a missing provider.
  readonly exhaustedCredentials: number
}

function noFreeRouteError(ctx: ExecutorContext, counts: NoRouteCounts): MatrixApiError {
  if (MatrixApiPool.overrideEntry(ctx.settings)?.classification === "OMNIROUTE_BACKED") {
    return ApiSchema.recursionDetected(
      "Direct Matrix API route would loop back through the configured OmniRoute gateway.",
    )
  }
  const evidence = `pool: ${counts.pool}, capability-compatible: ${counts.compatible}, selectable: ${counts.selectable}`
  if (counts.exhaustedCredentials > 0)
    return ApiSchema.noFreeRoute(
      `No usable Matrix route is currently selectable (${evidence}). Daily/provider quota is exhausted for ${counts.exhaustedCredentials} configured credential${
        counts.exhaustedCredentials === 1 ? "" : "s"
      }, so every route on it is skipped for this process. Retry after that provider's quota resets, or configure an independent provider.`,
    )
  return ApiSchema.noFreeRoute(
    `No usable Matrix route is currently selectable (${evidence}). Configure OmniRoute or an authenticated free direct provider.`,
  )
}

// The failure that ended a request, in the form the operator needs to act on
// it. `disposition` is the sanitized category and `status` the upstream HTTP
// code; neither carries provider content.
interface NoRouteFailure {
  readonly attempted: number
  // Capability-compatible candidates the request had not tried yet.
  readonly untried: number
  // Of those, the ones the router would still consider: not cooling down after
  // this failure and not disabled. Zero here with a non-zero `untried` is the
  // signature of a circuit-breaker block rather than a missing provider.
  readonly selectable: number
  readonly disposition?: MatrixReliable.FailureDisposition
  readonly status?: number
  // Provider credentials whose allowance was already spent, so their remaining
  // routes were never offered. This is why a configured provider can vanish
  // from the fallback set without having failed in this request.
  readonly exhaustedCredentials?: number
}

// Diagnostics for an exhausted route set. The previous fixed message told the
// operator to configure a provider, which is false — and actively misleading —
// when a provider was configured, answered, and failed. `pool` is the set the
// request actually drew from, so the counts separate "nothing is configured"
// from "routes are configured but none survived", and the failure category and
// status name the real cause. Nothing here is derived from request or provider
// content, so no secret can reach the client.
function noUsableProviderError(pool: readonly PoolEntry[], failure: NoRouteFailure): MatrixApiError {
  const evidence =
    `configured: ${pool.length}, attempted: ${failure.attempted}, ` +
    `untried: ${failure.untried}, selectable: ${failure.selectable}`
  const last =
    failure.disposition === undefined
      ? ""
      : ` Last failure: ${failure.disposition}${
          failure.status !== undefined && failure.status >= 100 ? ` (HTTP ${failure.status})` : ""
        }.`
  // A spent allowance is named before the generic advice: "configure a
  // provider" is false when the provider is configured, answered, and simply
  // has nothing left to spend, and "retry once the upstream recovers" hides how
  // long the operator actually has to wait.
  const quotaAdvice =
    failure.exhaustedCredentials === undefined || failure.exhaustedCredentials === 0
      ? undefined
      : ` Daily/provider quota is exhausted for ${failure.exhaustedCredentials} configured credential${
          failure.exhaustedCredentials === 1 ? "" : "s"
        }, so every other route on it is skipped for this process. Retry after that provider's quota resets, or use an independent provider.`
  const advice =
    quotaAdvice ??
    (pool.length === 0
      ? " Configure OmniRoute or an authenticated direct provider."
      : " Retry once the upstream recovers, or check that provider's route status.")
  return ApiSchema.noUsableProvider(`No usable Matrix route remains (${evidence}).${last}${advice}`)
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
  pool: readonly PoolEntry[],
  usable: MatrixRouter.Available,
) {
  const { router } = ctx
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
      const disposition = MatrixReliable.classifyFailure(code, text)
      const error = {
        message: text,
        ...(code === undefined ? {} : { code }),
        status: result.status,
      }

      // Free Auto leaves the bundled gateway entirely when the route it just
      // tried is OmniRoute-backed and failed in a way an independent provider
      // can absorb — but only when such a provider actually exists in the pool.
      // Without one, the bundled OmniRoute siblings must still be tried, so a
      // clean install is not left with an immediate no_usable_provider. Scoped
      // to the free profile and to OmniRoute-backed entries, so direct free
      // providers keep their existing sibling-fallback behavior and Vision and
      // Coding are untouched.
      const independentDirectFreeAvailable = pool.some(
        (candidateEntry) =>
          candidateEntry.classification === "DIRECT_FREE" &&
          MatrixCatalog.infrastructureId(candidateEntry.candidate) !==
            MatrixCatalog.infrastructureId(entry.candidate),
      )
      const switchToIndependentProvider =
        model.profile === "free" &&
        entry.classification === "OMNIROUTE_BACKED" &&
        independentDirectFreeAvailable &&
        (disposition === "payment_required" ||
          disposition === "rate_limit" ||
          disposition === "upstream_failure")
      // Permanent errors on a single-candidate pool (e.g. Direct auth 401 with
      // no other candidates): fail immediately. Free Auto's switch to an
      // independent provider is exempt, so a payment-required or unavailable
      // gateway route hands the request over instead of giving up.
      if (kind === "none" && disposition !== "restricted_external_route" && !switchToIndependentProvider)
        return yield* onFailure(ctx, entry, result)

      // Record the failure and try the next available candidate.
      if (disposition === "quota_exhausted") {
        // The allowance belongs to the provider account, so the credential is
        // marked spent for this process and the route is taken out with it. The
        // router is told "route", never "infrastructure": a spent quota is not
        // an outage, and it must not take an unrelated backend down with it.
        markQuotaExhausted(ctx, entry)
        router.recordFailure(entry.candidate, Number.POSITIVE_INFINITY, error, "route")
      } else {
        router.recordFailure(
          entry.candidate,
          disposition === "rate_limit"
            ? Math.max(COOLDOWN_MS.retry, result.retryAfterMs ?? 0)
            : COOLDOWN_MS[kind] || COOLDOWN_MS.fallback,
          error,
          MatrixReliable.failureScope(disposition),
        )
      }
      if (disposition === "restricted_external_route") {
        const opencode = toCandidates(pool).find(
          (candidate) => MatrixCatalog.infrastructureId(candidate) === "opencode",
        )
        if (opencode !== undefined) router.recordFailure(opencode, Number.POSITIVE_INFINITY, {
          message: text,
          ...(code === undefined ? {} : { code }),
          status: result.status,
        }, "infrastructure")
      }

      // A refused or unavailable route must not be answered by a sibling on the
      // same failed infrastructure. The restricted-route rule already drops
      // every OpenCode-backed candidate; Free Auto extends it to a
      // payment-required, rate-limited or unavailable OmniRoute route when an
      // independent DIRECT_FREE provider can take over, so the next attempt is
      // that provider rather than another route on the gateway that just failed.
      const avoidFailedInfrastructure =
        disposition === "restricted_external_route" || switchToIndependentProvider
      const others = pool
        // Every route resolving a spent credential is skipped, so a sibling on
        // the same exhausted account is never asked to answer a request the
        // account can no longer serve.
        .filter((candidateEntry) => !quotaExhaustedFor(ctx, candidateEntry))
        .map((candidateEntry) => candidateEntry.candidate)
        .filter(usable)
        .filter(
          (candidate) =>
            !attempted.has(candidate.id) &&
            (!avoidFailedInfrastructure ||
              (MatrixCatalog.infrastructureId(candidate) !== MatrixCatalog.infrastructureId(entry.candidate) &&
                MatrixCatalog.infrastructureId(candidate) !== "opencode")),
        )
      // `others` has already been narrowed to routes this request may still
      // use: capability, context, the loop guard, the exhausted-credential
      // filter and — for a refused route — the failed infrastructure itself.
      // Within that set the normal tier comes first and keeps cooldown intact.
      // Only when it finds nothing does the emergency tier ask the same
      // question with a transient cooldown relaxed, so an independent provider
      // that is merely pausing after one earlier failure can still take over a
      // request the route just tried cannot serve. Terminal holds stay excluded.
      const fallback =
        router.fallback(model.profile, others, () => true) ??
        router.emergencyFallback(model.profile, others, () => true)
      if (fallback === undefined)
        return yield* Effect.fail(
          noUsableProviderError(pool, {
            attempted: attempted.size,
            untried: others.length,
            selectable: router.selectableCount(model.profile, others, () => true),
            disposition,
            status: result.status,
            exhaustedCredentials: exhaustedCredentialCount(ctx, pool),
          }),
        )

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
  usable: MatrixRouter.Available,
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
            : disposition === "restricted_external_route"
              ? "infrastructure-restricted"
              : disposition === "authentication"
                ? "credential-switch"
                : disposition === "quota_exhausted"
                  ? "quota-exhausted"
                  : "cooldown"
      if (disposition === "model_not_supported") router.disable(entry.candidate, "model_not_supported", error)
      if (disposition === "payment_required") router.disable(entry.candidate, "payment_required", error)
      if (disposition === "rate_limit")
        router.recordFailure(entry.candidate, Math.max(COOLDOWN_MS.retry, result.retryAfterMs ?? 0), error)
      if (disposition === "upstream_failure") router.recordFailure(entry.candidate, COOLDOWN_MS.fallback, error)
      if (disposition === "restricted_external_route")
        router.recordFailure(entry.candidate, Number.POSITIVE_INFINITY, error, "infrastructure")
      // The allowance belongs to the provider account, not to the model route
      // that happened to answer. Marking the credential is what stops the
      // sibling OpenRouter route from being tried next; the route-level cooldown
      // keeps the router itself from re-selecting this exact route.
      if (disposition === "quota_exhausted") {
        markQuotaExhausted(ctx, entry)
        router.recordFailure(entry.candidate, Number.POSITIVE_INFINITY, error, "route")
      }
      yield* Effect.logWarning("Matrix reliable fallback", {
        candidate: entry.candidate.id,
        provider: entry.candidate.provider,
        model: entry.candidate.model,
        status: result.status,
        action,
        attempt,
        maxAttempts,
      })

      // Computed before the attempt budget is checked so an exhausted budget and
      // an empty pool report the same accounting: what was left capable, and how
      // much of that the circuit state still allowed.
      const others = reliableEligible
        .filter((candidateEntry) => disposition !== "authentication" || candidateEntry.keyEnv !== entry.keyEnv)
        // A credential whose allowance is already spent cannot serve anything
        // else this process, so its remaining routes are not candidates — not
        // even as a last resort. `quota_exhausted` set this state during this
        // request; an earlier request in the same process may have set it too.
        .filter((candidateEntry) => !quotaExhaustedFor(ctx, candidateEntry))
        .filter(
          (candidateEntry) =>
            disposition !== "restricted_external_route" ||
            MatrixCatalog.infrastructureId(candidateEntry.candidate) !== MatrixCatalog.infrastructureId(entry.candidate),
        )
        .map((candidateEntry) => candidateEntry.candidate)
        .filter(usable)
        .filter((candidate) => !attempted.has(candidate.id))
      const diagnostics: NoRouteFailure = {
        attempted: attempted.size,
        untried: others.length,
        selectable: router.selectableCount(model.profile as ProfileID, others, () => true),
        disposition,
        status: result.status,
        exhaustedCredentials: exhaustedCredentialCount(ctx, reliableEligible),
      }

      if (attempt >= maxAttempts)
        return yield* (disposition === "authentication"
          ? onFailure(ctx, entry, result)
          : Effect.fail(noUsableProviderError(reliableEligible, diagnostics)))

      // Same two tiers as the coding path: cooldown-respecting fallback first,
      // and the emergency tier — transient cooldown relaxed, terminal holds and
      // disabled routes still excluded — only when that found nothing. This is
      // what lets a request whose credential was just found spent still reach
      // an independent provider that happens to be cooling down from an earlier
      // transient failure.
      const fallback =
        router.fallback(model.profile as ProfileID, others, () => true, attemptedInfrastructures) ??
        router.emergencyFallback(model.profile as ProfileID, others, () => true, attemptedInfrastructures)
      if (fallback === undefined)
        return yield* (disposition === "authentication"
          ? onFailure(ctx, entry, result)
          : Effect.fail(noUsableProviderError(reliableEligible, diagnostics)))
      currentId = fallback.candidate.id
    }
  })
}

// Resolve each profile's selected candidate without widening its selection pool.
function entryFor(ctx: ExecutorContext, candidateId: string): PoolEntry | undefined {
  return [...ctx.freeAutoEligible, ...ctx.eligible, ...reliableEntries(ctx)].find(
    (entry) => entry.candidate.id === candidateId,
  )
}

// ---------------------------------------------------------------------------
// Provider/account quota state
// ---------------------------------------------------------------------------

// The identity a daily/account allowance belongs to. `keyEnv` is the credential
// `MatrixApiPool.credential` resolves the secret from, and `provider` keeps
// providers that happen to share an env var apart — so this groups exactly the
// routes drawing on one account: both OpenRouter free routes sit under
// `openrouter:OPENROUTER_API_KEY`, while Cerebras, each gateway-backed provider,
// the authenticated override and the local routes (`ollama:`, which has no key)
// keep their own scopes. Deliberately narrow: a gateway rejection must not
// remove the gateway's other routes, since those are separate upstreams and may
// still be independently usable.
function credentialScope(entry: PoolEntry): string {
  return `${entry.candidate.provider}:${entry.keyEnv}`
}

function quotaExhaustedFor(ctx: ExecutorContext, entry: PoolEntry): boolean {
  return ctx.quotaExhausted.has(credentialScope(entry))
}

function markQuotaExhausted(ctx: ExecutorContext, entry: PoolEntry): void {
  ctx.quotaExhausted.add(credentialScope(entry))
}

// How many distinct credentials are currently spent, counted over the entries
// they removed from selection. Reported so a configured provider that vanished
// from the pool is explained by the quota instead of looking unconfigured.
function exhaustedCredentialCount(ctx: ExecutorContext, entries: readonly PoolEntry[]): number {
  const exhausted = new Set<string>()
  for (const entry of entries) {
    const scope = credentialScope(entry)
    if (ctx.quotaExhausted.has(scope)) exhausted.add(scope)
  }
  return exhausted.size
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
