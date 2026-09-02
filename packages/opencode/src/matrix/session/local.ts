// Matrix Code local session store.
// A small, self-contained, file-backed store for per-session Matrix metadata
// (profile, provider/model, status, usage, model history, recovery state).
// It is intentionally independent of the core session projector: writing a
// Matrix session record never mutates project data. No cloud sync yet.

import path from "node:path"
import os from "node:os"

export type SessionStatus =
  | "IDLE"
  | "LISTENING"
  | "THINKING"
  | "CODING"
  | "TESTING"
  | "BUILDING"
  | "REVIEWING"
  | "ERROR"
  | "DONE"

export type ModelChangeReason =
  | "initial"
  | "manual-change"
  | "fallback-504"
  | "provider-offline"
  | "circuit-breaker"

export interface ModelHistoryEntry {
  timestamp: number
  profile: string
  provider: string
  model: string
  reason: ModelChangeReason
}

export interface TokenUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  contextUsagePercent?: number
  estimatedCost?: number
  known: boolean
}

export interface MatrixSession {
  id: string
  projectRef?: string
  createdAt: number
  updatedAt: number
  activeProfile?: string
  currentProvider?: string
  currentModel?: string
  status: SessionStatus
  retries: number
  fallbacks: number
  usage: TokenUsage
  modelHistory: ModelHistoryEntry[]
  recovery: {
    interruptedToolCalls: Array<{ tool: string; when: number; destructive: boolean }>
    lastActivityAt?: number
  }
}

/** Default storage directory for Matrix session records. */
export function defaultStorageDir(): string {
  return process.env.MATRIX_DATA_DIR ?? path.join(os.homedir(), ".matrix", "sessions")
}

function fileFor(dir: string, id: string): string {
  return path.join(dir, `${id.replace(/[^a-zA-Z0-9_.-]/g, "_")}.json`)
}

export interface LocalSessionStore {
  create(input: {
    id: string
    projectRef?: string
    profile?: string
    provider?: string
    model?: string
  }): Promise<MatrixSession>
  get(id: string): Promise<MatrixSession | null>
  save(session: MatrixSession): Promise<void>
  list(): Promise<MatrixSession[]>
}

/** A file-backed local session store. Each session is one small JSON file. */
export function createLocalSessionStore(dir: string = defaultStorageDir()): LocalSessionStore {
  return {
    async create(input) {
      const now = Date.now()
      const session: MatrixSession = {
        id: input.id,
        projectRef: input.projectRef,
        createdAt: now,
        updatedAt: now,
        activeProfile: input.profile,
        currentProvider: input.provider,
        currentModel: input.model,
        status: "IDLE",
        retries: 0,
        fallbacks: 0,
        usage: { known: false },
        modelHistory:
          input.provider && input.model
            ? [
                {
                  timestamp: now,
                  profile: input.profile ?? "",
                  provider: input.provider,
                  model: input.model,
                  reason: "initial",
                },
              ]
            : [],
        recovery: { interruptedToolCalls: [] },
      }
      await saveOne(dir, session)
      return session
    },

    async get(id) {
      const file = fileFor(dir, id)
      if (!(await Bun.file(file).exists())) return null
      try {
        return (await Bun.file(file).json()) as MatrixSession
      } catch {
        return null
      }
    },

    async save(session) {
      await saveOne(dir, { ...session, updatedAt: Date.now() })
    },

    async list() {
      const entries = new Bun.Glob("*.json").scanSync({ cwd: dir, absolute: true })
      const result: MatrixSession[] = []
      for (const entry of entries) {
        try {
          result.push((await Bun.file(entry).json()) as MatrixSession)
        } catch {
          // skip unreadable records
        }
      }
      return result
    },
  }
}

async function saveOne(dir: string, session: MatrixSession) {
  const file = fileFor(dir, session.id)
  await Bun.write(file, JSON.stringify(session, null, 2))
}

/** Convenience helpers to mutate a session and persist it. */
export async function recordModelChange(
  store: LocalSessionStore,
  id: string,
  entry: ModelHistoryEntry,
): Promise<MatrixSession | null> {
  const session = await store.get(id)
  if (!session) return null
  session.modelHistory = [...session.modelHistory, entry]
  session.currentProvider = entry.provider
  session.currentModel = entry.model
  session.activeProfile = entry.profile
  if (entry.reason !== "initial") session.fallbacks += 1
  await store.save(session)
  return session
}

export async function recordTokenUsage(
  store: LocalSessionStore,
  id: string,
  usage: Partial<TokenUsage>,
): Promise<MatrixSession | null> {
  const session = await store.get(id)
  if (!session) return null
  session.usage = {
    ...session.usage,
    ...usage,
    known: usage.inputTokens !== undefined || usage.outputTokens !== undefined || usage.totalTokens !== undefined,
  }
  await store.save(session)
  return session
}

export async function setStatus(
  store: LocalSessionStore,
  id: string,
  status: SessionStatus,
): Promise<MatrixSession | null> {
  const session = await store.get(id)
  if (!session) return null
  session.status = status
  session.recovery.lastActivityAt = Date.now()
  await store.save(session)
  return session
}

/**
 * Record an interrupted tool call as incomplete so a resumed session does not
 * blindly repeat it. Destructive operations are flagged and require explicit
 * confirmation before they may be re-run.
 */
export async function markInterruptedToolCall(
  store: LocalSessionStore,
  id: string,
  input: { tool: string; destructive: boolean },
): Promise<MatrixSession | null> {
  const session = await store.get(id)
  if (!session) return null
  session.recovery.interruptedToolCalls.push({ tool: input.tool, when: Date.now(), destructive: input.destructive })
  session.recovery.lastActivityAt = Date.now()
  await store.save(session)
  return session
}

/** Removes a previously interrupted tool call once it has been safely handled. */
export async function clearInterruptedToolCall(
  store: LocalSessionStore,
  id: string,
  tool: string,
): Promise<MatrixSession | null> {
  const session = await store.get(id)
  if (!session) return null
  session.recovery.interruptedToolCalls = session.recovery.interruptedToolCalls.filter((t) => t.tool !== tool)
  await store.save(session)
  return session
}
