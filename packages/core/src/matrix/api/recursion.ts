// Recursion protection for the local Matrix API.
//
// Requests entering through the Matrix API must never flow back through the
// OmniRoute path that called Matrix. Two mechanisms work together:
//
// 1. STRUCTURAL: chat requests never use the OmniRoute provider at all. They
//    only travel through an explicitly configured direct upstream, and the
//    server refuses a direct upstream that is the same OmniRoute endpoint.
//
// 2. HOP GUARD: every outbound request is stamped with `x-matrix-origin` and
//    `x-matrix-hop`. Any nested Matrix API in the chain increments the hop and
//    rejects requests that already reached the configured maximum depth, so a
//    misconfigured chain back into Matrix terminates with a structured error
//    instead of looping.

export const ORIGIN_HEADER = "x-matrix-origin"

// Value stamped on outbound requests to mark them as Matrix-API-originated.
export const ORIGIN_VALUE = "matrix-api"

export const HOP_HEADER = "x-matrix-hop"

// Parse an incoming hop counter. Missing, empty or malformed values count as 0
// (an ordinary external client that never saw Matrix headers). Only well-formed
// decimal counters are honored so forged garbage cannot game the guard.
export function parseHop(value: string | null | undefined): number {
  if (value === undefined || value === null) return 0
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return 0
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : 0
}

// Hop counter to propagate on outbound requests for a request that arrived with
// the given incoming hops.
export function nextHop(incomingHops: number): number {
  return incomingHops + 1
}

// Returns true when the request already carries Matrix-API provenance.
export function isMatrixOrigin(value: string | null | undefined): boolean {
  return value === ORIGIN_VALUE
}

// Outbound recursion headers for a request that will travel downstream.
export function propagationHeaders(incomingHops: number): Record<string, string> {
  return { [ORIGIN_HEADER]: ORIGIN_VALUE, [HOP_HEADER]: String(nextHop(incomingHops)) }
}

export * as MatrixApiRecursion from "./recursion"