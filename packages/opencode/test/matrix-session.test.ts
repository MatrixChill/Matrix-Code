import { afterAll, describe, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import {
  createLocalSessionStore,
  markInterruptedToolCall,
  clearInterruptedToolCall,
  recordModelChange,
  recordTokenUsage,
  setStatus,
} from "../src/matrix/session/local"

const dir = `${import.meta.dir}/fixture-sessions`

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // cleanup is best-effort
  }
})

describe("LocalSessionStore", () => {
  test("create persists a session and get returns it", async () => {
    const store = createLocalSessionStore(dir)
    const s = await store.create({ id: "s1", projectRef: "demo", profile: "reliable", provider: "omniroute", model: "m" })
    const got = await store.get("s1")
    expect(got?.id).toBe("s1")
    expect(got?.status).toBe("IDLE")
    expect(got?.modelHistory).toHaveLength(1)
    expect(got?.modelHistory[0].reason).toBe("initial")
    expect(s.createdAt).toBeGreaterThan(0)
  })

  test("recordModelChange appends history and bumps fallbacks", async () => {
    const store = createLocalSessionStore(dir)
    await store.create({ id: "s2", provider: "omniroute", model: "a", profile: "reliable" })
    const updated = await recordModelChange(store, "s2", {
      timestamp: Date.now(),
      profile: "fast",
      provider: "openai",
      model: "b",
      reason: "fallback-504",
    })
    expect(updated?.modelHistory).toHaveLength(2)
    expect(updated?.currentModel).toBe("b")
    expect(updated?.fallbacks).toBe(1)
  })

  test("recordTokenUsage only marks known when a real figure is provided", async () => {
    const store = createLocalSessionStore(dir)
    await store.create({ id: "s3", provider: "omniroute", model: "a" })
    await recordTokenUsage(store, "s3", { inputTokens: 120, outputTokens: 30 })
    const got = await store.get("s3")
    expect(got?.usage.totalTokens).toBeUndefined()
    expect(got?.usage.inputTokens).toBe(120)
    expect(got?.usage.known).toBe(true)

    await recordTokenUsage(store, "s3", {})
    const got2 = await store.get("s3")
    expect(got2?.usage.known).toBe(false)
  })

  test("setStatus updates state and activity time", async () => {
    const store = createLocalSessionStore(dir)
    await store.create({ id: "s4", provider: "omniroute", model: "a" })
    const updated = await setStatus(store, "s4", "CODING")
    expect(updated?.status).toBe("CODING")
    expect(updated?.recovery.lastActivityAt).toBeGreaterThan(0)
  })

  test("list returns persisted sessions and get on missing returns null", async () => {
    const store = createLocalSessionStore(dir)
    expect(await store.get("missing")).toBeNull()
    const all = await store.list()
    expect(all.length).toBeGreaterThanOrEqual(4)
  })

  test("interrupted destructive tool call is marked and cleared", async () => {
    const store = createLocalSessionStore(dir)
    await store.create({ id: "s5", provider: "omniroute", model: "a" })
    const marked = await markInterruptedToolCall(store, "s5", { tool: "shell(destructive)", destructive: true })
    expect(marked?.recovery.interruptedToolCalls).toHaveLength(1)
    expect(marked?.recovery.interruptedToolCalls[0].destructive).toBe(true)

    const cleared = await clearInterruptedToolCall(store, "s5", "shell(destructive)")
    expect(cleared?.recovery.interruptedToolCalls).toHaveLength(0)
  })
})
