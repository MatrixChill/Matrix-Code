export * as MatrixRouterService from "./router-service"

import { Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { MatrixCatalog } from "./catalog"
import { MatrixReliable } from "./reliable"
import { MatrixRouter } from "./router"

// Cooldown applied after a real request failure, per failure kind. `retry`
// failures (rate limits) cool down briefly so the same model can recover;
// `fallback` failures (provider 500/504, timeouts) cool down longer so the
// router prefers another candidate. Permanent failures are not recorded at all.
const COOLDOWN_MS: Readonly<Record<MatrixReliable.RecoverableKind, number>> = {
  retry: 30_000,
  fallback: 120_000,
  none: 0,
}

// Sanitized failure metadata that is safe to transport over the routing
// snapshot endpoint and to render in the TUI: no credentials, request payloads,
// prompts, or response bodies.
export class RouterCandidateFailure extends Schema.Class<RouterCandidateFailure>("MatrixRouterCandidateFailure")({
  message: Schema.String,
  code: Schema.String.pipe(Schema.optional),
  status: Schema.Number.pipe(Schema.optional),
  at: Schema.Number,
}) {}

export class RouterCandidateState extends Schema.Class<RouterCandidateState>("MatrixRouterCandidateState")({
  id: Schema.String,
  provider: Schema.String,
  model: Schema.String,
  health: Schema.Number,
  cooldownUntil: Schema.Number,
  recentFailures: Schema.Number,
  lastError: RouterCandidateFailure.pipe(Schema.optional),
}) {}

export class RoutingSnapshot extends Schema.Class<RoutingSnapshot>("MatrixRoutingSnapshot")({
  candidates: RouterCandidateState.pipe(Schema.Array),
  updatedAt: Schema.Number,
}) {}

// A request failure recorded into the router. Only structured, sanitized
// metadata is accepted; never raw headers, payloads, prompts, or bodies.
export interface RecordFailureInput {
  readonly providerID: string
  readonly modelID: string
  readonly message: string
  readonly code?: string
  readonly status?: number
}

export interface Interface {
  readonly recordFailure: (input: RecordFailureInput) => void
  readonly recordSuccess: (input: { readonly providerID: string; readonly modelID: string }) => void
  readonly snapshot: () => RoutingSnapshot
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Matrix/RouterService") {}

const ALL_CANDIDATES: readonly MatrixCatalog.Candidate[] = [
  ...MatrixCatalog.CATALOG,
  ...MatrixCatalog.VISION_CANDIDATES,
]

function candidateFor(providerID: string, modelID: string): MatrixCatalog.Candidate | undefined {
  return ALL_CANDIDATES.find((candidate) => candidate.provider === providerID && candidate.model === modelID)
}

// Strip credential-looking tokens and key=value credentials from an error
// message so provider-embedded secrets never reach the router state or the TUI.
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_\-]{8,}\b/g,
  /\bBearer [A-Za-z0-9._~+/=\-]{8,}\b/gi,
  /\b(?:api[_-]?key|access[_-]?token|token|authorization|secret|password)\b\s*[:=]\s*[^\s,;]+\b/gi,
  /\b(?:[\w.+-]+)\?[^=\s]*[=(][^&=\s]+/g,
]

export function sanitizeMessage(message: string): string {
  let cleaned = message
  for (const pattern of SECRET_PATTERNS) cleaned = cleaned.replace(pattern, "[REDACTED]")
  cleaned = cleaned.replace(/\s+/g, " ").trim()
  return cleaned.length > 500 ? `${cleaned.slice(0, 500)}...` : cleaned
}

function recordFailure(router: MatrixRouter.Router, input: RecordFailureInput): void {
  const candidate = candidateFor(input.providerID, input.modelID)
  if (candidate === undefined) return
  const code = input.code ?? (input.status === undefined ? undefined : String(input.status))
  const kind = MatrixReliable.classifyError(code, input.message)
  if (kind === "none") return
  router.recordFailure(candidate, COOLDOWN_MS[kind], {
    message: sanitizeMessage(input.message),
    ...(code === undefined ? {} : { code }),
    ...(input.status === undefined ? {} : { status: input.status }),
  })
}

function recordSuccess(router: MatrixRouter.Router, input: { readonly providerID: string; readonly modelID: string }): void {
  const candidate = candidateFor(input.providerID, input.modelID)
  if (candidate === undefined) return
  router.recordSuccess(candidate)
}

function snapshotOf(router: MatrixRouter.Router): RoutingSnapshot {
  return new RoutingSnapshot({
    candidates: [...router.snapshot()].flatMap(([id, state]) => {
      const candidate = ALL_CANDIDATES.find((c) => c.id === id)
      if (candidate === undefined) return []
      return [
        new RouterCandidateState({
          id,
          provider: candidate.provider,
          model: candidate.model,
          health: state.health,
          cooldownUntil: state.cooldownUntil,
          recentFailures: state.recentFailures,
          ...(state.lastError === undefined
            ? {}
            : {
                lastError: new RouterCandidateFailure({
                  message: state.lastError.message,
                  ...(state.lastError.code === undefined ? {} : { code: state.lastError.code }),
                  ...(state.lastError.status === undefined ? {} : { status: state.lastError.status }),
                  at: state.lastError.at,
                }),
              }),
        }),
      ]
    }),
    updatedAt: Date.now(),
  })
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const router = MatrixRouter.make()
    return Service.of({
      recordFailure: (input) => recordFailure(router, input),
      recordSuccess: (input) => recordSuccess(router, input),
      snapshot: () => snapshotOf(router),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [] })