// Chat execution for the local OpenAI-compatible Matrix API.
//
// A chat completion NEVER routes through the OmniRoute provider. It only
// travels through an explicitly configured direct upstream (`baseURL`), and the
// executor refuses when that direct upstream is the same endpoint as the known
// OmniRoute gateway. Outbound requests are stamped with recursion headers so a
// chain of Matrix APIs cannot loop; a mis-configured chain is cut at the hop
// limit with a structured error.

import { Context, Effect, Layer } from "effect"
import { randomUUID } from "node:crypto"
import { LLM, Message, type LLMError } from "@opencode-ai/llm"
import { OpenAICompatible } from "@opencode-ai/llm/providers"
import { LLMClient, Auth } from "@opencode-ai/llm/route"
import { MatrixRouterService } from "../router-service"
import { routesToOmniRoute, type Settings } from "./config"
import { find } from "./models"
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

export interface Executor {
  readonly settings: Settings
  readonly chatCompletion: (input: ChatCompletionInput) => Effect.Effect<ChatCompletionResponse, MatrixApiError>
}

export class Service extends Context.Service<Service, Executor>()("@opencode/Matrix/Api") {}

export function layer(settings: Settings) {
  const chatCompletion = chatCompletionImpl(settings) as Executor["chatCompletion"]
  return Layer.succeed(Service, Service.of({ settings, chatCompletion }))
}

const chatCompletionImpl = (settings: Settings) =>
  Effect.fn("MatrixApi.chatCompletion")(function* (input: ChatCompletionInput) {
    // Auth was already checked by the HTTP middleware; this is the durable
    // guard so the executor stays safe even when reused without the server.
    if (settings.apiKey === undefined) return yield* Effect.fail(ApiSchema.notConfigured())

    const hops = input.incomingHop
    if (hops >= settings.maxHops) return yield* Effect.fail(ApiSchema.hopLimitExceeded(hops))

    const model = find(input.request.model)
    if (model === undefined) return yield* Effect.fail(ApiSchema.modelNotFound(input.request.model))

    if (settings.directBaseURL === undefined)
      return yield* Effect.fail(
        ApiSchema.noSafeRoute(
          "No safe direct execution route is configured. Set MATRIX_API_DIRECT_BASE_URL to a non-OmniRoute upstream.",
        ),
      )
    if (routesToOmniRoute(settings.directBaseURL, settings.omnirouteBaseURL))
      return yield* Effect.fail(
        ApiSchema.recursionDetected(
          "The configured direct route points at the OmniRoute gateway that would call Matrix. Refusing to loop.",
        ),
      )

    if (input.request.max_tokens !== undefined && input.request.max_tokens < 1)
      return yield* Effect.fail(ApiSchema.invalidRequest("max_tokens must be a positive integer", "invalid_max_tokens"))

    if (input.request.messages.length === 0)
      return yield* Effect.fail(ApiSchema.invalidRequest("messages must contain at least one message", "empty_messages"))

    const { system, history } = splitMessages(input.request.messages)
    const generation = {
      ...(input.request.temperature === undefined ? {} : { temperature: input.request.temperature }),
      ...(input.request.max_tokens === undefined ? {} : { maxTokens: input.request.max_tokens }),
    }

    const upstream = OpenAICompatible.configure({
      provider: "matrix-api",
      baseURL: settings.directBaseURL,
      ...(settings.directApiKey === undefined
        ? { auth: Auth.passthrough }
        : { apiKey: settings.directApiKey }),
    }).model(model.upstreamModel)

    const request = LLM.request({
      model: upstream,
      system,
      messages: history,
      generation,
      http: { headers: propagationHeaders(hops) },
    })

    const llm = yield* LLMClient.Service
    const response = yield* llm.generate(request).pipe(
      Effect.catch((error: LLMError) =>
        Effect.fail(
          ApiSchema.upstreamFailure(MatrixRouterService.sanitizeMessage(error.message), upstreamStatus(error)),
        ),
      ),
    )

    return chatCompletionResponse({
      id: `chatcmpl-${randomUUID()}`,
      created: Math.floor(Date.now() / 1000),
      model: input.request.model,
      content: response.text,
      finishReason: mapFinishReason(response.finishReason),
      promptTokens: response.usage?.inputTokens,
      completionTokens: response.usage?.outputTokens,
    })
  })

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

export * as MatrixApiExecutor from "./executor"