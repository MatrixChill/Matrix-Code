export * as MatrixRoute from "./route"

export interface RouteCapabilities {
  readonly vision: boolean
  readonly toolCalls: boolean
  readonly streaming: boolean
  readonly maxContext: number
}

export interface RouteScoring {
  readonly coding: number
  readonly reasoning: number
  readonly speed: number
  readonly toolCalls: number
  readonly cost: number
}

export interface Route {
  readonly id: string
  readonly providerId: string
  readonly infrastructureId: string
  readonly modelId: string
  readonly capabilities: RouteCapabilities
  readonly scoring: RouteScoring
}

const BUILTIN_ROUTES: readonly Route[] = [
  {
    id: "omniroute/matrix-free-coding",
    providerId: "omniroute",
    infrastructureId: "omniroute-auto",
    modelId: "auto/coding:free",
    capabilities: { vision: false, toolCalls: true, streaming: true, maxContext: 128000 },
    scoring: { coding: 0.8, reasoning: 0.7, speed: 0.6, toolCalls: 0.8, cost: 0 },
  },
  {
    id: "omniroute/matrix-vision",
    providerId: "omniroute",
    infrastructureId: "opencode",
    modelId: "opencode/mimo-v2.5-free",
    capabilities: { vision: true, toolCalls: true, streaming: true, maxContext: 128000 },
    scoring: { coding: 0.7, reasoning: 0.7, speed: 0.7, toolCalls: 0.7, cost: 0 },
  },
  {
    id: "openrouter/nemotron-3-ultra-free",
    providerId: "openrouter",
    infrastructureId: "openrouter-cloud",
    modelId: "nvidia/nemotron-3-ultra-550b-a55b:free",
    capabilities: { vision: true, toolCalls: true, streaming: true, maxContext: 200000 },
    scoring: { coding: 0.7, reasoning: 0.7, speed: 0.6, toolCalls: 0.8, cost: 0 },
  },
  {
    id: "cerebras/glm-5-turbo",
    providerId: "cerebras",
    infrastructureId: "cerebras-cloud",
    modelId: "glm-5-turbo",
    capabilities: { vision: false, toolCalls: true, streaming: true, maxContext: 200000 },
    scoring: { coding: 0.8, reasoning: 0.8, speed: 0.8, toolCalls: 0.8, cost: 0 },
  },
]

export function getRoutesForProvider(providerId: string): readonly Route[] {
  return BUILTIN_ROUTES.filter((r) => r.providerId === providerId)
}

export function listRoutes(): readonly Route[] {
  return BUILTIN_ROUTES
}
