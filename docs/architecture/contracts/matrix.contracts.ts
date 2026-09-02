/**
 * Matrix Code — design contracts (FOUNDATION phase).
 *
 * This file is a NON-DESTRUCTIVE design reference for future module interfaces.
 * It lives under /docs deliberately: it is NOT part of any build, typecheck or
 * package, so it changes nothing at runtime and cannot break the project.
 *
 * These types are the agreed contracts for the Model Router, Matrix Doctor,
 * Matrix Models, Matrix Vision, Permissions and Memory layers. Each future
 * implementation phase should conform to these before writing the module.
 */

/* ------------------------------------------------------------------ */
/* Model Router                                                        */
/* ------------------------------------------------------------------ */

export type MatrixProfile =
  | "smart"
  | "coding-max"
  | "reliable"
  | "fast"
  | "vision"
  | "free"
  | "local"

export type CostTier = "free" | "low" | "medium" | "high"
export type ModelHealth = "healthy" | "degraded" | "down"

export interface ModelMetadata {
  id: string
  provider: string
  profiles: ReadonlyArray<MatrixProfile>
  codingQuality: number
  reasoning: number
  speed: number
  toolCallReliability: number
  vision: boolean
  contextSize: number
  cost: CostTier
  health: ModelHealth
  latencyMs?: number
}

export interface SelectedModel {
  profile: MatrixProfile
  model: ModelMetadata
  provider: string
  requestedId: string
  fallbackChain: ReadonlyArray<string>
}

/* ------------------------------------------------------------------ */
/* Fallback / Reliability                                              */
/* ------------------------------------------------------------------ */

export type FailableStatus =
  | 429
  | 500
  | 502
  | 503
  | 504
  | "network-timeout"
  | "provider-offline"
  | "idle-timeout"

export interface ReliabilityPolicy {
  maxRetries: number
  retryDelayMs: number
  fallbackEnabled: boolean
  circuitBreaker: {
    threshold: number
    cooldownMs: number
  }
}

/* ------------------------------------------------------------------ */
/* Matrix Doctor (/matrix-status)                                      */
/* ------------------------------------------------------------------ */

export type ComponentName =
  | "core"
  | "voice"
  | "clipboard"
  | "magic-context"
  | "agents"
  | "skills"
  | "omniroute"
  | "providers"
  | "browser"
  | "git"
  | "vision"
  | "portable"

export type CheckResult = "pass" | "fail" | "warn" | "unknown"

export interface MatrixStatusRow {
  component: ComponentName
  result: CheckResult
  detail?: string
}

/* ------------------------------------------------------------------ */
/* Matrix Models (/matrix-models)                                      */
/* ------------------------------------------------------------------ */

export interface MatrixModelsRow {
  profile: MatrixProfile
  provider: string
  modelId: string
  latencyMs?: number
  health: ModelHealth
  toolCallReliability: number
  vision: boolean
  recentErrors: ReadonlyArray<FailableStatus>
  fallbackStatus: "idle" | "active" | "exhausted"
}

/* ------------------------------------------------------------------ */
/* Matrix Vision                                                       */
/* ------------------------------------------------------------------ */

export type VisionRequest = "screenshot" | "ui" | "asset" | "organize" | "identify" | "compare"

export interface VisionAnalysisResult {
  success: boolean
  summary?: string
  modelUsed?: string
  error?: string
}

/* ------------------------------------------------------------------ */
/* Permissions                                                         */
/* ------------------------------------------------------------------ */

export type PermissionCategory =
  | "read"
  | "write"
  | "execute"
  | "network"
  | "browser"
  | "git"
  | "delete"
  | "deploy"

export type PermissionLevel = "safe" | "ask" | "always-ask" | "blocked"

/* ------------------------------------------------------------------ */
/* Memory                                                              */
/* ------------------------------------------------------------------ */

export interface ProjectMemory {
  architecture: string
  decisions: string
  preferences: string
  projectContext: string
}
