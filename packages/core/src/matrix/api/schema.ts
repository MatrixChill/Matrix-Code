// OpenAI-compatible wire shapes for the local Matrix API.
//
// This module defines the request/response/error JSON contracts only. It must
// stay free of Effect services so it is trivially unit-testable. Response
// builders return plain objects matching the documented OpenAI shapes; request
// bodies are decoded through Schema so malformed input fails cleanly as 400.

import { Schema } from "effect"

const TextContentPart = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })
const ImageContentPart = Schema.Struct({
  type: Schema.Literal("image_url"),
  image_url: Schema.Struct({
    url: Schema.String,
    detail: Schema.optional(Schema.Union([Schema.Literal("auto"), Schema.Literal("low"), Schema.Literal("high")])),
  }),
})

const MessageToolCall = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("function"),
  function: Schema.Struct({
    name: Schema.String,
    arguments: Schema.String,
  }),
})

export class ChatMessage extends Schema.Class<ChatMessage>("Matrix.ChatMessage")({
  role: Schema.Union([
    Schema.Literal("user"),
    Schema.Literal("assistant"),
    Schema.Literal("system"),
    Schema.Literal("tool"),
  ]),
  content: Schema.Union([Schema.String, Schema.Null, Schema.Array(Schema.Union([TextContentPart, ImageContentPart]))]),
  tool_calls: Schema.optional(Schema.Array(MessageToolCall)),
  tool_call_id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
}) {}

const ToolFunction = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  parameters: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})

const ToolDefinition = Schema.Struct({
  type: Schema.Literal("function"),
  function: ToolFunction,
})

export class ChatCompletionRequest extends Schema.Class<ChatCompletionRequest>("Matrix.ChatCompletionRequest")({
  model: Schema.String,
  messages: Schema.Array(ChatMessage),
  temperature: Schema.optional(Schema.Number),
  max_tokens: Schema.optional(Schema.Int),
  stream: Schema.optional(Schema.Boolean),
  tools: Schema.optional(Schema.Array(ToolDefinition)),
  tool_choice: Schema.optional(
    Schema.Union([
      Schema.Literal("auto"),
      Schema.Literal("none"),
      Schema.Literal("required"),
      Schema.Struct({
        type: Schema.Literal("function"),
        function: Schema.Struct({ name: Schema.String }),
      }),
    ]),
  ),
}) {}

// ---------------------------------------------------------------------------
// Response builders
// ---------------------------------------------------------------------------

export interface ChatCompletionResponse {
  readonly id: string
  readonly object: "chat.completion"
  readonly created: number
  readonly model: string
  readonly choices: ReadonlyArray<{
    readonly index: number
    readonly message: { readonly role: "assistant"; readonly content: string | null; readonly tool_calls?: ReadonlyArray<{
      readonly id: string
      readonly type: "function"
      readonly function: { readonly name: string; readonly arguments: string }
    }> }
    readonly finish_reason: string
  }>
  readonly usage?: {
    readonly prompt_tokens: number
    readonly completion_tokens: number
    readonly total_tokens: number
  }
}

export function chatCompletionResponse(input: {
  id: string
  created: number
  model: string
  content: string
  finishReason: string
  promptTokens?: number
  completionTokens?: number
  toolCalls?: ReadonlyArray<{ id: string; name: string; input: unknown }>
}): ChatCompletionResponse {
  const usage =
    input.promptTokens !== undefined || input.completionTokens !== undefined
      ? {
          prompt_tokens: input.promptTokens ?? 0,
          completion_tokens: input.completionTokens ?? 0,
          total_tokens: (input.promptTokens ?? 0) + (input.completionTokens ?? 0),
        }
      : undefined
  const toolCalls =
    input.toolCalls !== undefined && input.toolCalls.length > 0
      ? input.toolCalls.map((call) => ({
          id: call.id,
          type: "function" as const,
          function: { name: call.name, arguments: JSON.stringify(call.input) },
        }))
      : undefined
  return {
    id: input.id,
    object: "chat.completion",
    created: input.created,
    model: input.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: toolCalls !== undefined ? null : input.content,
          ...(toolCalls !== undefined ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: input.finishReason,
      },
    ],
    ...(usage === undefined ? {} : { usage }),
  }
}

// Map the LLM package finish reasons onto OpenAI-compatible values. Unknown
// reasons fall back to "stop" so the wire contract always carries a valid value.
export function mapFinishReason(reason: string): string {
  switch (reason) {
    case "stop":
      return "stop"
    case "length":
      return "length"
    case "tool-calls":
      return "tool_calls"
    case "content-filter":
      return "content_filter"
    default:
      return "stop"
  }
}

// ---------------------------------------------------------------------------
// API errors
// ---------------------------------------------------------------------------

export interface ApiErrorBody {
  readonly error: {
    readonly type: string
    readonly message: string
    readonly code?: string
    readonly param?: string
    readonly status: number
  }
}

// Every failure the API can return is a structured JSON error with an HTTP
// status. `message` is always sanitized before it reaches a client or a log.
export class MatrixApiError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    message: string,
    readonly code?: string,
    readonly param?: string,
  ) {
    super(message)
    this.name = "MatrixApiError"
  }

  get body(): ApiErrorBody {
    return {
      error: {
        type: this.type,
        message: this.message,
        status: this.status,
        ...(this.code === undefined ? {} : { code: this.code }),
        ...(this.param === undefined ? {} : { param: this.param }),
      },
    }
  }
}

export function invalidRequest(message: string, code = "invalid_request"): MatrixApiError {
  return new MatrixApiError(400, "invalid_request_error", message, code)
}

export function notConfigured(): MatrixApiError {
  return new MatrixApiError(
    503,
    "server_config_error",
    "The Matrix API is enabled but not authenticated. Set MATRIX_API_KEY.",
    "no_api_key",
  )
}

export function authenticationFailed(): MatrixApiError {
  return new MatrixApiError(
    401,
    "authentication_error",
    "Invalid or missing authorization header.",
    "invalid_api_key",
  )
}

export function modelNotFound(model: string): MatrixApiError {
  return new MatrixApiError(404, "invalid_request_error", `Model '${model}' is not exposed by Matrix.`, "model_not_found")
}

export function hopLimitExceeded(hops: number): MatrixApiError {
  return new MatrixApiError(
    400,
    "recursion_error",
    `Request reached the Matrix recursion hop limit (${hops}).`,
    "hop_limit_exceeded",
  )
}

export function recursionDetected(message: string): MatrixApiError {
  return new MatrixApiError(400, "recursion_error", message, "no_safe_route")
}

export function noSafeRoute(message: string): MatrixApiError {
  return new MatrixApiError(503, "server_config_error", message, "no_safe_route")
}

export function noFreeRoute(message: string): MatrixApiError {
  return new MatrixApiError(503, "server_config_error", message, "no_free_route")
}

export function upstreamFailure(message: string, status = 502): MatrixApiError {
  return new MatrixApiError(status, "upstream_error", message, "upstream_request_failed")
}

export * as MatrixApiSchema from "./schema"
