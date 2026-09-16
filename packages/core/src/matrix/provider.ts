export * as MatrixProvider from "./provider"

export type ProviderKind = "direct" | "gateway" | "local"
export type ProviderProtocol = "openai-compatible" | "native"

export type ProviderAuth =
  | {
      readonly type: "bearer"
      readonly apiKeyEnv: string
    }
  | {
      readonly type: "header"
      readonly apiKeyEnv: string
      readonly headerName: string
    }
  | {
      readonly type: "none"
    }

export type ProviderEndpoint =
  | {
      readonly type: "static"
      readonly baseURL: string
    }
  | {
      readonly type: "runtime"
      readonly configKey: string
    }

export type FailureScope = "route" | "infrastructure" | "credential" | "request"

export interface ProviderConfig {
  readonly id: string
  readonly name: string
  readonly kind: ProviderKind
  readonly protocol: ProviderProtocol
  readonly endpoint: ProviderEndpoint
  readonly auth: ProviderAuth
}

const BUILTIN_PROVIDERS: readonly ProviderConfig[] = [
  {
    id: "omniroute",
    name: "OmniRoute",
    kind: "gateway",
    protocol: "openai-compatible",
    endpoint: { type: "runtime", configKey: "OMNIROUTE_BASE_URL" },
    auth: { type: "bearer", apiKeyEnv: "OMNIROUTE_API_KEY" },
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    kind: "direct",
    protocol: "openai-compatible",
    endpoint: { type: "static", baseURL: "https://openrouter.ai/api/v1" },
    auth: { type: "bearer", apiKeyEnv: "OPENROUTER_API_KEY" },
  },
  {
    id: "cerebras",
    name: "Cerebras",
    kind: "direct",
    protocol: "openai-compatible",
    endpoint: { type: "static", baseURL: "https://api.cerebras.ai/v1" },
    auth: { type: "bearer", apiKeyEnv: "CEREBRAS_API_KEY" },
  },
]

export function getProvider(id: string): ProviderConfig | undefined {
  return BUILTIN_PROVIDERS.find((p) => p.id === id)
}

export function listProviders(): readonly ProviderConfig[] {
  return BUILTIN_PROVIDERS
}
