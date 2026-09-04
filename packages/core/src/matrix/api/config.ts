// Runtime configuration for the local OpenAI-compatible Matrix API.
//
// Everything comes from the environment so the API fails closed by default and
// no credential ever lives in source. The listen address is fixed to loopback
// on purpose: this first iteration is explicitly local-only.

export const DEFAULT_PORT = 20260
export const HOST = "127.0.0.1"

// Name of the env var holding the Matrix API bearer token.
export const API_KEY_ENV = "MATRIX_API_KEY"

export interface Settings {
  readonly enabled: boolean
  readonly host: string
  readonly port: number
  readonly maxHops: number
  // Bearer token clients must present. Never log or expose it.
  readonly apiKey?: string
  // Safe non-OmniRoute upstream the API may route chat requests to.
  readonly directBaseURL?: string
  // Optional bearer token for the direct upstream.
  readonly directApiKey?: string
  // Known OmniRoute gateway endpoint (when set) used to refuse routing back
  // through the same path that could call Matrix.
  readonly omnirouteBaseURL?: string
}

const parseBool = (value: string | undefined) => {
  if (value === undefined) return false
  return value.trim().toLowerCase() === "true" || value.trim() === "1"
}

const parseIntSafe = (value: string | undefined, fallback: number) => {
  if (value === undefined) return fallback
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback
}

export function fromEnv(env: Readonly<Record<string, string | undefined>> = process.env): Settings {
  const enabled = parseBool(env.MATRIX_API_ENABLED)
  const port = parseIntSafe(env.MATRIX_API_PORT, DEFAULT_PORT)
  const maxHops = parseIntSafe(env.MATRIX_API_MAX_HOPS, 2) || 2
  const apiKey = env[API_KEY_ENV]?.trim() || undefined
  const directBaseURL = env.MATRIX_API_DIRECT_BASE_URL?.trim() || undefined
  const directApiKey = env.MATRIX_API_DIRECT_API_KEY?.trim() || undefined
  const omnirouteBaseURL = env.OMNIROUTE_BASE_URL?.trim() || undefined

  const safePort = port >= 0 && port <= 65_535 ? port : DEFAULT_PORT
  return {
    enabled,
    host: HOST,
    port: safePort,
    maxHops: maxHops >= 1 ? maxHops : 2,
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(directBaseURL === undefined ? {} : { directBaseURL }),
    ...(directApiKey === undefined ? {} : { directApiKey }),
    ...(omnirouteBaseURL === undefined ? {} : { omnirouteBaseURL }),
  }
}

// The API only starts in a usable state when it is enabled AND carries a key.
// Enabled without a key is a misconfiguration: fail closed instead of serving
// unauthenticated traffic or crashing on a missing credential.
export function isConfigured(settings: Settings): boolean {
  return settings.enabled && settings.apiKey !== undefined
}

// Public status shape. It deliberately mirrors `Settings` except the apiKey and
// directApiKey, which are never exposed.
export interface Status {
  readonly enabled: boolean
  readonly bindAddress: string
  readonly port: number
  readonly maxHops: number
  readonly authentication: "configured" | "not_configured"
  readonly directRoute: {
    readonly configured: boolean
    readonly baseURL?: string
    readonly routesToOmniRoute: boolean
  }
}

export function status(settings: Settings): Status {
  const direct = settings.directBaseURL === undefined ? undefined : settings.directBaseURL
  const unsafe = direct !== undefined && routesToOmniRoute(direct, settings.omnirouteBaseURL)
  return {
    enabled: settings.enabled,
    bindAddress: `${settings.host}:${settings.port}`,
    port: settings.port,
    maxHops: settings.maxHops,
    authentication: settings.apiKey === undefined ? "not_configured" : "configured",
    directRoute: {
      configured: direct !== undefined,
      ...(direct === undefined ? {} : { baseURL: direct }),
      routesToOmniRoute: unsafe,
    },
  }
}

// Two endpoints are the same listener for recursion protection when protocol,
// normalized host and effective port all match. Base paths are deliberately
// NOT part of the identity: routing back to the same OmniRoute gateway is
// dangerous no matter which API prefix is used, so a path difference must not
// make an unsafe direct route look safe. The check is pure and deterministic:
// no DNS or network resolution ever happens here. Loopback spellings
// (localhost, 127.0.0.1, ::1) collapse to one host so a direct route cannot
// slip past by spelling the same gateway differently.
interface EndpointIdentity {
  readonly protocol: string
  readonly host: string
  readonly port: number
}

// Compare two endpoint configs to decide whether the direct route would call
// back into the same OmniRoute gateway. Comparison is conservative: a match
// blocks the route, so spelling differences never turn an unsafe direct route
// into a safe-looking one.
export function routesToOmniRoute(baseURL: string, omnirouteBaseURL: string | undefined): boolean {
  if (omnirouteBaseURL === undefined || omnirouteBaseURL.trim() === "") return false
  const direct = parseEndpoint(baseURL)
  const omniroute = parseEndpoint(omnirouteBaseURL)
  if (direct === undefined || omniroute === undefined) return false
  return direct.protocol === omniroute.protocol && direct.host === omniroute.host && direct.port === omniroute.port
}

function parseEndpoint(value: string): EndpointIdentity | undefined {
  const url = parseUrl(value)
  if (url === undefined) return undefined
  return {
    protocol: url.protocol,
    host: normalizeHost(url.hostname),
    port: effectivePort(url),
  }
}

// Accept a URL that carries a scheme, or a clearly host:port-shaped literal
// (for example "127.0.0.1:20128" or "localhost:20128/v1") with http://
// prepended. Anything else is left untouched so new URL() decides: malformed
// values resolve to undefined below and never throw.
function parseUrl(value: string): URL | undefined {
  const literal = value.trim()
  const defaulted = matchSchemelessEndpoint(literal) === undefined ? literal : `http://${literal}`
  try {
    return new URL(defaulted)
  } catch {
    return undefined
  }
}

function matchSchemelessEndpoint(value: string): RegExpExecArray | undefined {
  const plain = /^([^/:[\]]+):(\d{1,5})(\/.*)?$/.exec(value)
  if (plain !== null) return plain
  return /^\[([^\]]+)\]:(\d{1,5})(\/.*)?$/.exec(value) ?? undefined
}

function normalizeHost(hostname: string): string {
  const host = hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase()
  return isLoopback(host) ? "127.0.0.1" : host
}

function isLoopback(host: string): boolean {
  if (host === "localhost" || host === "::1") return true
  if (host === "0:0:0:0:0:0:0:1" || host === "::ffff:127.0.0.1" || host === "::ffff:7f00:1") return true
  return /^127(?:\.\d{1,3}){3}$/.test(host)
}

function effectivePort(url: URL): number {
  if (url.port !== "") return Number(url.port)
  if (url.protocol === "http:") return 80
  if (url.protocol === "https:") return 443
  return 0
}

export * as MatrixApiConfig from "./config"