export * as MatrixOmniRouteHealth from "./omniroute-health"

import type { GatewayProbe } from "./routing-status"
import type { GatewayModel } from "./catalog"

// Same timeout the first-run OmniRoute setup dialog uses for its reachability
// check, so the sensor and the setup agree on what "timed out" means.
export const PROBE_TIMEOUT_MS = 3500

// Live reachability probe for the OmniRoute gateway, backed by the OpenAI-style
// /models endpoint. Any HTTP response counts as reachable (the gateway is up,
// even for 401/5xx); only a network-level failure marks it unreachable. It never
// infers provider health from the response, and it sends no credentials.
export async function probe(baseURL: string, timeoutMs: number = PROBE_TIMEOUT_MS): Promise<GatewayProbe> {
  const checkedAt = new Date()
  try {
    const response = await fetch(`${baseURL.replace(/\/+$/, "")}/models`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    return { reachable: true, statusCode: response.status, checkedAt }
  } catch (error) {
    return { reachable: false, error: error instanceof Error ? error.name : String(error), checkedAt }
  }
}

// Result of a live /v1/models fetch from the OmniRoute gateway.
export interface GatewayModelList {
  readonly models: readonly GatewayModel[]
  readonly fetchedAt: Date
}

interface RawGatewayModel {
  readonly id?: unknown
  readonly name?: unknown
  readonly context_length?: unknown
  readonly modalities?: { readonly output?: readonly unknown[] }
}

// Fetch the models the OmniRoute gateway advertises through its OpenAI-style
// /v1/models endpoint. Unlike probe(), this requires a 2xx and a parseable
// `{ data: [{ id, ... }] }` body; anything else yields undefined so callers can
// fall back to the built-in catalog. Sends no credentials and never throws.
export async function listModels(
  baseURL: string,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<GatewayModelList | undefined> {
  try {
    const response = await fetch(`${baseURL.replace(/\/+$/, "")}/models`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return undefined
    const payload = (await response.json().catch(() => undefined)) as { data?: readonly unknown[] } | undefined
    if (!payload || !Array.isArray(payload.data)) return undefined
    const models = payload.data.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null) return []
      const model = toGatewayModel(entry as RawGatewayModel)
      return model === undefined ? [] : [model]
    })
    return { models, fetchedAt: new Date() }
  } catch {
    return undefined
  }
}

function toGatewayModel(entry: RawGatewayModel): GatewayModel | undefined {
  const id = typeof entry.id === "string" ? entry.id.trim() : ""
  if (id.length === 0) return undefined
  return {
    id,
    ...(typeof entry.name === "string" && entry.name.trim().length > 0 ? { name: entry.name } : {}),
    ...(typeof entry.context_length === "number" && Number.isFinite(entry.context_length) && entry.context_length > 0
      ? { context: entry.context_length }
      : {}),
    ...(Array.isArray(entry.modalities?.output) && entry.modalities.output.includes("image") ? { vision: true } : {}),
  }
}