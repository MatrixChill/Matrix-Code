// Chat execution for the local OpenAI-compatible Matrix API.
//
// A chat completion NEVER routes through the OmniRoute provider. It only
// travels through Matrix's own direct provider pool — real OpenAI-compatible
// free providers Matrix reaches directly (see pool.ts) — or, as a legacy
// override, an explicitly configured `MATRIX_API_DIRECT_BASE_URL` upstream.
// OmniRoute-backed candidates are rejected up front (recursion protection),
// and the legacy direct override is only used when no eligible free candidate
// exists. Outbound requests are stamped with recursion headers so a chain of
// Matrix APIs cannot loop; a mis-configured chain is cut at the hop limit with
// a structured error.
//
// `matrix-coding` picks the best eligible free candidate once.
// `matrix-coding-reliable` retries and falls back across the eligible pool via
// MatrixRouter health/cooldown plus MatrixReliable error classification.

import { Context, Effect, Layer } from "effect"
import { randomUUID } from "node:crypto"
import { LLM, Message, type LLMError, type Model } from "@opencode-ai/llm"
import { OpenAICompatible } from "@opencode-ai/llm/providers"
import { LLMClient, Auth } from "@opencode-ai/llm/route"
import { MatrixRouterService } from "../router-service"
import { MatrixRouter } from "../router"
import { MatrixReliable } from "../reliable"
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

// Secret-free routing snapshot for the status endpoint: last selected pool
// candidate and the candidates currently in cooldown / degraded health.
export interface RouteStatus {
  readonly lastSelected: string | null
  readonly fallbackCandidates: ReadonlyArray<string>
}

export interface Executor {
  readonly settings: Settings
  readonly chatCompletion: (input: ChatCompletionInput) => Effect.Effect<ChatCompletionResponse, MatrixApiError>
  readonly routeStatus: () => RouteStatus
}

export class Service extends Context.Service<Service, Executor>()("@opencode/Matrix/Api") {}

interface ExecutorContext {
  readonly settings: Settings
  readonly router: MatrixRouter.Router
  readonly eligible: readonly PoolEntry[]
  readonly state: { lastSelected: string | undefined }
}

export function layer(settings: Settings) {
  const resolved = MatrixApiPool.resolvePool(settings, settings.poolEnv)
  const override = MatrixApiPool.overrideEntry(settings)
  const allEligible: PoolEntry[] = [...resolved.free]
  if (override !== undefined && override.classification === "DIRECT_AUTHENTICATED" && resolved.free.length === 0) {
    allEligible.push(override)
  }
  const ctx: ExecutorContext = {
    settings,
    router: MatrixRouter.make(),
    eligible: allEligible,
    state: { lastSelected: undefined },
  }
  const chatCompletion = chatCompletionImpl(ctx) as Executor["chatCompletion"]
  const routeStatus = () => routeStatusImpl(ctx)
  return Layer.succeed(Service, Service.of({ settings, chatCompletion, routeStatus }))
}

const chatCompletionImpl =
  (ctx: ExecutorContext) =>
  Effect.fn("MatrixApi.chatCompletion")(function* (input: ChatCompletionInput) {
    const { settings, eligible } = ctx
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
      return yield* Effect.fail(ApiSchema.invalidRequest("messages must contain at least one message", "empty_messages"))

    const candidates = toCandidates(eligible)
    const selection =
      candidates.length === 0
        ? undefined
        : ctx.router.select(model.profile, candidates, () => true)

    if (selection === undefined) return yield* Effect.fail(noFreeRouteError(ctx))

    if (model.profile === "reliable") return yield* runReliable(ctx, input, model, selection, hops)
    return yield* runSingleCoding(ctx, input, model, selection, hops)
  })

function toCandidates(entries: readonly PoolEntry[]) {
  return entries.map((entry) => entry.candidate)
}

function noFreeRouteError(ctx: ExecutorContext): MatrixApiError {
  const { settings } = ctx
  const resolved = MatrixApiPool.resolvePool(settings, settings.poolEnv)
  const rejected = resolved.omniroute.length
  const override = MatrixApiPool.overrideEntry(settings)

  if (
    resolved.free.length === 0 &&
    override !== undefined &&
    override.classification === "OMNIROUTE_BACKED"
  ) {
    return ApiSchema.recursionDetected(
      "Direct Matrix API route would loop back through the configured OmniRoute gateway.",
    )
  }

  return ApiSchema.noFreeRoute(
    `No direct free Matrix provider is eligible (eligible: ${ctx.eligible.length}, rejected OmniRoute-backed: ${rejected}). ` +
      "Configure a free provider credential in the pool (e.g. OPENROUTER_API_KEY) or set " +
      "MATRIX_API_DIRECT_BASE_URL/MATRIX_API_DIRECT_API_KEY as an explicit override, then retry.",
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
  const facade = apiKey === undefined
    ? OpenAICompatible.configure({ provider: "matrix-api", baseURL: entry.baseURL })
    : OpenAICompatible.configure({ provider: "matrix-api", baseURL: entry.baseURL, apiKey })
  return { upstream: facade.model(entry.candidate.model), keyEnv: entry.keyEnv }
}

function buildRequest(
  input: ChatCompletionInput,
  model: MatrixModel,
  built: BuiltRequest,
  hops: number,
) {
  const { system, history } = splitMessages(input.request.messages)
  const generation = {
    ...(input.request.temperature === undefined ? {} : { temperature: input.request.temperature }),
    ...(input.request.max_tokens === undefined ? {} : { maxTokens: input.request.max_tokens }),
  }
  return LLM.request({
    model: built.upstream,
    system,
    messages: history,
    generation,
    http: { headers: propagationHeaders(hops) },
  })
}

type AttemptResult =
  | { readonly ok: true; readonly response: ChatCompletionResponse }
  | { readonly ok: false; readonly error: LLMError; readonly status: number }

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
    const response = yield* llm.generate(request).pipe(
      Effect.mapError((error: LLMError) => new UpstreamAttemptFailure(error, upstreamStatus(error))),
    )
    return {
      ok: true as const,
      response: chatCompletionResponse({
        id: `chatcmpl-${randomUUID()}`,
        created: Math.floor(Date.now() / 1000),
        model: input.request.model,
        content: response.text,
        finishReason: mapFinishReason(response.finishReason),
        promptTokens: response.usage?.inputTokens,
        completionTokens: response.usage?.outputTokens,
      }),
    }
  }).pipe(Effect.catch((failure: UpstreamAttemptFailure) => Effect.succeed({ ok: false as const, error: failure.error, status: failure.status })))
}

function onSuccess(ctx: ExecutorContext, entry: PoolEntry, result: Extract<AttemptResult, { ok: true }>) {
  ctx.router.recordSuccess(entry.candidate)
  ctx.state.lastSelected = entry.candidate.id
  return Effect.succeed(result.response)
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
// matrix-coding: single best-eligible selection
// ---------------------------------------------------------------------------

function runSingleCoding(
  ctx: ExecutorContext,
  input: ChatCompletionInput,
  model: MatrixModel,
  selection: MatrixRouter.Selection,
  hops: number,
) {
  const entry = entryFor(ctx, selection.candidate.id)
  if (entry === undefined) return Effect.fail(ApiSchema.noFreeRoute("Selected pool candidate is not available."))
  return Effect.gen(function* () {
    const result = yield* runAttempt(ctx, input, model, entry, hops)
    if (result.ok) return yield* onSuccess(ctx, entry, result)
    return yield* onFailure(ctx, entry, result)
  })
}

// ---------------------------------------------------------------------------
// matrix-coding-reliable: retry then fallback across the eligible pool
// ---------------------------------------------------------------------------

function runReliable(
  ctx: ExecutorContext,
  input: ChatCompletionInput,
  model: MatrixModel,
  first: MatrixRouter.Selection,
  hops: number,
) {
  return Effect.gen(function* () {
    const { settings, router, eligible } = ctx
    const maxAttempts = settings.maxAttempts
    let currentId = first.candidate.id
    let attempt = 0
    while (true) {
      const entry = entryFor(ctx, currentId)
      if (entry === undefined) return yield* Effect.fail(ApiSchema.noFreeRoute("Selected pool candidate is not available."))
      attempt += 1
      const result = yield* runAttempt(ctx, input, model, entry, hops)
      if (result.ok) return yield* onSuccess(ctx, entry, result)

      const text = MatrixRouterService.sanitizeMessage(result.error.message)
      const code = result.status >= 400 && result.status < 600 ? String(result.status) : undefined
      const kind = MatrixReliable.classifyError(code, text)
      // Permanent errors never trigger a fallback (prompt/auth issues).
      if (kind === "none") return yield* onFailure(ctx, entry, result)

      router.recordFailure(entry.candidate, COOLDOWN_MS[kind], {
        message: text,
        ...(code === undefined ? {} : { code }),
        status: result.status,
      })

      // Decide whether to retry the same candidate or fall back to another.
      const others = toCandidates(eligible).filter((candidate) => candidate.id !== currentId)
      const decision = MatrixReliable.decideFailure(
        code,
        text,
        attempt,
        maxAttempts,
        router,
        model.profile as ProfileID,
        others,
        () => true,
      )
      if (decision.action === "continue") continue
      if (decision.action === "fallback") {
        currentId = decision.selection!.candidate.id
        attempt = 0
        continue
      }
      return yield* Effect.fail(ApiSchema.upstreamFailure(text, result.status))
    }
  })
}

function entryFor(ctx: ExecutorContext, candidateId: string): PoolEntry | undefined {
  return ctx.eligible.find((entry) => entry.candidate.id === candidateId)
}

// ---------------------------------------------------------------------------
// Status snapshot
// ---------------------------------------------------------------------------

function routeStatusImpl(ctx: ExecutorContext): RouteStatus {
  const now = Date.now()
  const fallbackCandidates: string[] = []
  for (const entry of ctx.eligible) {
    const state = ctx.router.state(entry.candidate)
    if (state !== undefined && (state.cooldownUntil > now || state.health < 1)) {
      fallbackCandidates.push(entry.candidate.id)
    }
  }
  return { lastSelected: ctx.state.lastSelected ?? null, fallbackCandidates }
}

// ---------------------------------------------------------------------------
// Messages / helpers
// ---------------------------------------------------------------------------

function splitMessages(messages: ReadonlyArray<ChatCompletionRequest["messages"][number]>) {
  const system: string[] = []
  const history: Array<Message.Input> = []
  for (const message of messages) {
    if (message.role === "system") {
      system.push(messageText(message))
      continue
    }
    history.push(
      message.role === "user" ? Message.user(messageText(message)) : Message.assistant(messageText(message)),
    )
  }
  return { system: system.join("\n\n"), history }
}

function messageText(message: ChatCompletionRequest["messages"][number]): string {
  if (message.content === null) return ""
  if (typeof message.content === "string") return message.content
  return message.content.map((part) => part.text).join("")
}

// Derive an HTTP status from the provider error when it carries one.
function upstreamStatus(error: LLMError): number {
  if ("status" in error.reason) return error.reason.status ?? 502
  return 502
}

export { MatrixProfile }
export * as MatrixApiExecutor from "./executor"
