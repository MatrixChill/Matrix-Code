// Matrix-owned logical models exposed through the OpenAI-compatible API.
//
// These are Matrix identities (profiles), NOT external provider models. The
// API only ever claims ownership of these ids; execution is resolved by the
// executor against a configured direct upstream.

export const MODEL_CODING = "matrix-coding" as const
export const MODEL_CODING_RELIABLE = "matrix-coding-reliable" as const

export interface MatrixModel {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly profile: string
  // Model id sent to the direct upstream. Defaults to the logical id.
  readonly upstreamModel: string
}

export const MODELS: readonly MatrixModel[] = [
  {
    id: MODEL_CODING,
    name: "Matrix Coding",
    description: "Balanced Matrix coding profile tuned for everyday development work.",
    profile: "coding-max",
    upstreamModel: MODEL_CODING,
  },
  {
    id: MODEL_CODING_RELIABLE,
    name: "Matrix Coding Reliable",
    description: "Matrix reliability-first coding profile for careful, tool-heavy work.",
    profile: "reliable",
    upstreamModel: MODEL_CODING_RELIABLE,
  },
]

export function find(id: string): MatrixModel | undefined {
  return MODELS.find((model) => model.id === id)
}

// Stable creation timestamp used in /v1/models entries so responses are
// deterministic. This is the model's virtual creation, not a provider secret.
const CREATED_AT = 1_750_000_000

export interface ModelListPayload {
  readonly object: "list"
  readonly data: ReadonlyArray<{
    readonly id: string
    readonly object: "model"
    readonly created: number
    readonly owned_by: "matrix"
  }>
}

export function listPayload(): ModelListPayload {
  return {
    object: "list",
    data: MODELS.map((model) => ({
      id: model.id,
      object: "model",
      created: CREATED_AT,
      owned_by: "matrix",
    })),
  }
}

export * as MatrixApiModels from "./models"