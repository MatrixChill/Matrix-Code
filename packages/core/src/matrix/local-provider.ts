export * as MatrixLocalProvider from "./local-provider"

import type { Candidate } from "./catalog"

export const DEFAULT_BASE_URL = "http://127.0.0.1:11434"
export const DEFAULT_TIMEOUT_MS = 250
export const DEFAULT_TTL_MS = 30_000

export interface LocalRoute {
  readonly candidate: Candidate
  readonly baseURL: string
  readonly keyEnv: ""
  readonly free: true
  readonly classification: "LOCAL"
}

interface Options {
  readonly baseURL?: string
  readonly timeoutMs?: number
  readonly ttlMs?: number
  readonly now?: () => number
  readonly fetch?: typeof fetch
}

interface CacheEntry {
  readonly expiresAt: number
  readonly routes: readonly LocalRoute[]
}

const cache = new Map<string, CacheEntry>()

export async function discover(options: Options = {}): Promise<readonly LocalRoute[]> {
  const baseURL = (options.baseURL ?? DEFAULT_BASE_URL).replace(/\/$/, "")
  const now = options.now?.() ?? Date.now()
  const cached = cache.get(baseURL)
  if (cached !== undefined && cached.expiresAt > now) return cached.routes

  const routes = await discoverUncached(baseURL, options.fetch ?? fetch, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  cache.set(baseURL, { routes, expiresAt: now + (options.ttlMs ?? DEFAULT_TTL_MS) })
  return routes
}

export function invalidate(baseURL = DEFAULT_BASE_URL): void {
  cache.delete(baseURL.replace(/\/$/, ""))
}

async function discoverUncached(baseURL: string, request: typeof fetch, timeoutMs: number) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const response = await request(`${baseURL}/api/tags`, { signal: controller.signal }).catch(() => undefined)
  clearTimeout(timeout)
  if (response?.ok !== true) return []

  const payload = await response.json().catch(() => undefined)
  if (!isRecord(payload) || !Array.isArray(payload.models)) return []
  const names = payload.models.flatMap((model) =>
    isRecord(model) && typeof model.name === "string" && model.name.trim() !== "" ? [model.name.trim()] : [],
  )
  return (await Promise.all(names.map((name) => inspectModel(baseURL, name, request, timeoutMs)))).filter(
    (route): route is LocalRoute => route !== undefined,
  )
}

async function inspectModel(
  baseURL: string,
  name: string,
  request: typeof fetch,
  timeoutMs: number,
): Promise<LocalRoute | undefined> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const response = await request(`${baseURL}/api/show`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: name }),
    signal: controller.signal,
  }).catch(() => undefined)
  clearTimeout(timeout)
  if (response?.ok !== true) return undefined

  const payload = await response.json().catch(() => undefined)
  if (!isRecord(payload)) return undefined
  const capabilities = Array.isArray(payload.capabilities)
    ? payload.capabilities.filter((value): value is string => typeof value === "string")
    : []
  const context = isRecord(payload.model_info)
    ? Object.entries(payload.model_info).find(
        ([key, value]) => key.endsWith(".context_length") && isPositiveNumber(value),
      )?.[1]
    : undefined
  const toolCalls = capabilities.includes("tools")
  const vision = capabilities.includes("vision")
  return {
    candidate: {
      id: `ollama/${name}`,
      name: `Ollama ${name}`,
      provider: "ollama",
      infrastructureId: "ollama-local",
      model: name,
      coding: 0.55,
      reasoning: 0.5,
      speed: 0.4,
      toolCalls: toolCalls ? 0.6 : 0,
      vision,
      cost: 0,
      context: typeof context === "number" ? context : -1,
      profiles: toolCalls && typeof context === "number" ? ["reliable"] : [],
    },
    baseURL: `${baseURL}/v1`,
    keyEnv: "" as const,
    free: true as const,
    classification: "LOCAL" as const,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
}
