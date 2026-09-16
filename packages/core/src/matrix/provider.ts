export * as MatrixProvider from "./provider"

export type ProviderKind = "direct" | "gateway" | "local"
export type ProviderProtocol = "openai-compatible" | "native"
export type ProviderAccess = "managed" | "anonymous" | "local" | "api-key" | "oauth" | "device-code"

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
  readonly access: ProviderAccess
}

const BUILTIN_PROVIDERS: readonly ProviderConfig[] = [
  {
    id: "omniroute",
    name: "OmniRoute",
    kind: "gateway",
    protocol: "openai-compatible",
    endpoint: { type: "runtime", configKey: "OMNIROUTE_BASE_URL" },
    auth: { type: "bearer", apiKeyEnv: "OMNIROUTE_API_KEY" },
    access: "managed",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    kind: "direct",
    protocol: "openai-compatible",
    endpoint: { type: "static", baseURL: "https://openrouter.ai/api/v1" },
    auth: { type: "bearer", apiKeyEnv: "OPENROUTER_API_KEY" },
    access: "api-key",
  },
  {
    id: "cerebras",
    name: "Cerebras",
    kind: "direct",
    protocol: "openai-compatible",
    endpoint: { type: "static", baseURL: "https://api.cerebras.ai/v1" },
    auth: { type: "bearer", apiKeyEnv: "CEREBRAS_API_KEY" },
    access: "api-key",
  },
  {
    id: "ollama",
    name: "Ollama",
    kind: "local",
    protocol: "openai-compatible",
    endpoint: { type: "static", baseURL: "http://127.0.0.1:11434/v1" },
    auth: { type: "none" },
    access: "local",
  },
]

export function getProvider(id: string): ProviderConfig | undefined {
  return BUILTIN_PROVIDERS.find((p) => p.id === id)
}

export function listProviders(): readonly ProviderConfig[] {
  return BUILTIN_PROVIDERS
}
