export * as MatrixOmniRouteHealth from "./omniroute-health"

import type { GatewayProbe } from "./routing-status"

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