import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { createServer, type Server, type IncomingMessage } from "node:http"
import { MatrixApiConfig, type Settings } from "./config"
import { MatrixApiPool } from "./pool"
import { mapFinishReason, chatCompletionResponse } from "./schema"
import { MatrixRouterService } from "../router-service"
import { MatrixApiServer } from "./server"

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

type StubMode = "ok" | "error500"

interface StubRecord {
  headers: IncomingMessage["headers"]
  count: number
}

function stubServer(mode: StubMode): Promise<{ server: Server; url: string; record: StubRecord }> {
  return new Promise((resolve, reject) => {
    const record: StubRecord = { headers: {}, count: 0 }
    const server = createServer((req, res) => {
      record.headers = req.headers
      record.count++
      if (mode === "error500") {
        res.writeHead(500, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: { message: "boom sk-TESTREALAK31337 boom" } }))
        return
      }
      const events = [
        {
          id: "chatcmpl-stub",
          object: "chat.completion.chunk",
          created: 1778031210,
          model: "stub",
          choices: [
            {
              index: 0,
              delta: { content: "Hello from Matrix API" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
        },
      ]
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" })
      res.end(`${events.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\ndata: [DONE]\n\n`)
    })
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, record })
    })
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

const baseSettings = (overrides: Partial<Settings> = {}): Settings => ({
  enabled: true,
  host: "127.0.0.1",
  port: 0,
  maxHops: 2,
  maxAttempts: 3,
  apiKey: "matrix-test-secret-key-e5d8",
  ...overrides,
})

// Run `run` while the Matrix API is listening, then tear the API down.
function withApi<T>(settings: Settings, run: (listener: { url: string }) => Promise<T>): Promise<T> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const listener = yield* MatrixApiServer.listen(settings)
        return yield* Effect.tryPromise(() => run(listener))
      }),
    ),
  )
}

async function getJson(url: string, headers: Record<string, string> = {}) {
  return fetch(url, { headers })
}

// Parse a JSON response body as a test-only typed payload.
function readJson<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>
}

function bearer(key: string): Record<string, string> {
  return { Authorization: `Bearer ${key}` }
}

// POST a JSON chat body; the third argument can override the request body.
function postChat(
  url: string,
  key: string,
  body: string = JSON.stringify({ model: "matrix-coding", messages: [{ role: "user", content: "Say hi" }] }),
  extraHeaders: Record<string, string> = {},
) {
  return fetch(url, {
    method: "POST",
    headers: { ...bearer(key), "content-type": "application/json", ...extraHeaders },
    body,
  })
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

describe("Matrix API config", () => {
  test("defaults fail closed and bind to loopback on 20260", () => {
    const settings = MatrixApiConfig.fromEnv({})
    expect(settings).toMatchObject({ enabled: false, host: "127.0.0.1", port: 20260, maxHops: 2 })
    expect(settings.apiKey).toBeUndefined()
    expect(MatrixApiConfig.isConfigured(settings)).toBe(false)
  })

  test("enabled with a key is configured and shows a secret-free status", () => {
    const settings = MatrixApiConfig.fromEnv({
      MATRIX_API_ENABLED: "true",
      MATRIX_API_KEY: "sk-most-secret-key-987654321",
      MATRIX_API_DIRECT_BASE_URL: "http://127.0.0.1:9990/v1",
      OMNIROUTE_BASE_URL: "http://127.0.0.1:20128",
    })
    expect(MatrixApiConfig.isConfigured(settings)).toBe(true)
    expect(settings.port).toBe(20260)
    const snapshot = MatrixApiConfig.status(settings)
    expect(snapshot.authentication).toBe("configured")
    expect(snapshot.directRoute).toMatchObject({ configured: true, baseURL: "http://127.0.0.1:9990/v1" })
    expect(JSON.stringify(snapshot)).not.toContain("most-secret")
  })

  test("routesToOmniRoute detects the identical gateway ignoring trailing slashes", () => {
    expect(
      MatrixApiConfig.routesToOmniRoute("https://omniroute.example/v1", "https://omniroute.example/v1/"),
    ).toBe(true)
    expect(MatrixApiConfig.routesToOmniRoute("https://other.example/v1", "https://omniroute.example/v1")).toBe(false)
    expect(MatrixApiConfig.routesToOmniRoute("https://other.example/v1", undefined)).toBe(false)
  })
})

describe("Matrix API recursion detection", () => {
  test("blocks the exact same gateway URL", () => {
    expect(MatrixApiConfig.routesToOmniRoute("http://127.0.0.1:20128/v1", "http://127.0.0.1:20128/v1")).toBe(true)
  })

  test("blocks the same listener with a different base path", () => {
    expect(MatrixApiConfig.routesToOmniRoute("http://127.0.0.1:20128", "http://127.0.0.1:20128/v1")).toBe(true)
    expect(MatrixApiConfig.routesToOmniRoute("http://127.0.0.1:20128/v1", "http://127.0.0.1:20128")).toBe(true)
    expect(MatrixApiConfig.routesToOmniRoute("http://127.0.0.1:20128/v1", "http://127.0.0.1:20128/v1/")).toBe(true)
    expect(MatrixApiConfig.routesToOmniRoute("http://localhost:20128", "http://127.0.0.1:20128/v1/")).toBe(true)
  })

  test("treats loopback aliases as the same local host", () => {
    expect(MatrixApiConfig.routesToOmniRoute("http://localhost:20128/v1", "http://127.0.0.1:20128/v1")).toBe(true)
    expect(MatrixApiConfig.routesToOmniRoute("http://LOCALHOST:20128/v1", "http://127.0.0.1:20128/v1")).toBe(true)
    expect(MatrixApiConfig.routesToOmniRoute("http://[::1]:20128/v1", "http://127.0.0.1:20128/v1")).toBe(true)
  })

  test("normalizes default ports", () => {
    expect(MatrixApiConfig.routesToOmniRoute("http://localhost:80/v1", "http://localhost/v1")).toBe(true)
    expect(MatrixApiConfig.routesToOmniRoute("https://omniroute.example:443/v1", "https://omniroute.example/v1")).toBe(
      true,
    )
  })

  test("blocks schemeless local endpoints that resolve to the same listener", () => {
    expect(MatrixApiConfig.routesToOmniRoute("localhost:20128", "http://127.0.0.1:20128")).toBe(true)
    expect(MatrixApiConfig.routesToOmniRoute("127.0.0.1:20128", "localhost:20128")).toBe(true)
    expect(MatrixApiConfig.routesToOmniRoute("127.0.0.1:20128/v1", "http://localhost:20128/v1")).toBe(true)
  })

  test("allows a genuinely different port", () => {
    expect(MatrixApiConfig.routesToOmniRoute("http://127.0.0.1:20129/v1", "http://127.0.0.1:20128/v1")).toBe(false)
    expect(MatrixApiConfig.routesToOmniRoute("127.0.0.1:20128", "127.0.0.1:20260")).toBe(false)
  })

  test("allows a genuinely different remote host", () => {
    expect(MatrixApiConfig.routesToOmniRoute("https://other.example/v1", "https://omniroute.example/v1")).toBe(false)
    expect(MatrixApiConfig.routesToOmniRoute("other.example:20128", "https://omniroute.example/v1")).toBe(false)
  })

  test("handles malformed junk safely", () => {
    expect(MatrixApiConfig.routesToOmniRoute("not a url", "http://127.0.0.1:20128/v1")).toBe(false)
    expect(MatrixApiConfig.routesToOmniRoute("http://127.0.0.1:20128/v1", "not a url")).toBe(false)
    expect(MatrixApiConfig.routesToOmniRoute("", "http://127.0.0.1:20128/v1")).toBe(false)
    expect(MatrixApiConfig.routesToOmniRoute("chat/ completions", "chat/ completions")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Schema and helpers
// ---------------------------------------------------------------------------

describe("Matrix API schema", () => {
  test("chatCompletionResponse omits usage when token counts are unavailable", () => {
    const response = chatCompletionResponse({
      id: "chatcmpl-x",
      created: 123,
      model: "matrix-coding",
      content: "hi",
      finishReason: "stop",
    })
    expect(response.object).toBe("chat.completion")
    expect(response.choices[0].message.role).toBe("assistant")
    expect(response.choices[0].finish_reason).toBe("stop")
    expect("usage" in response).toBe(false)
  })

  test("chatCompletionResponse reports real token counts when provided", () => {
    const response = chatCompletionResponse({
      id: "chatcmpl-x",
      created: 123,
      model: "matrix-coding",
      content: "hi",
      finishReason: "length",
      promptTokens: 7,
      completionTokens: 3,
    })
    expect(response.usage).toEqual({ prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 })
  })

  test("mapFinishReason maps tool-calls to tool_calls", () => {
    expect(mapFinishReason("tool-calls")).toBe("tool_calls")
    expect(mapFinishReason("stop")).toBe("stop")
    expect(mapFinishReason("bogus")).toBe("stop")
  })

  test("sanitizeMessage strips credential-looking tokens", () => {
    const sanitized = MatrixRouterService.sanitizeMessage("boom sk-TESTREALAK31337 api_key=sk-leaky2222 boom")
    expect(sanitized).not.toContain("sk-TESTREALAK31337")
    expect(sanitized).not.toContain("sk-leaky2222")
  })
})

// ---------------------------------------------------------------------------
// Test-only response payload types
// ---------------------------------------------------------------------------

interface ModelEntry {
  id: string
  object: string
  owned_by: string
}

interface ModelsResponse {
  object: string
  data: ModelEntry[]
}

interface ChatChoice {
  message: { role: string; content: string }
  finish_reason: string
}

interface ChatCompletionResponse {
  object: string
  choices: ChatChoice[]
  model: string
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}

interface ErrorResponse {
  error: { type: string; code?: string; message: string }
}

interface StatusResponse {
  enabled: boolean
  bindAddress: string
  authentication: string
}

// ---------------------------------------------------------------------------
// HTTP integration
// ---------------------------------------------------------------------------

describe("Matrix API HTTP", () => {
  test("GET /v1/models returns only Matrix-owned models", async () => {
    const settings = baseSettings()
    await withApi(settings, async (listener) => {
      const response = await getJson(`${listener.url}/v1/models`, bearer(settings.apiKey!))
      expect(response.status).toBe(200)
      const payload = await readJson<ModelsResponse>(response)
      expect(payload.object).toBe("list")
      expect(payload.data.map((entry: { id: string }) => entry.id)).toEqual(
        expect.arrayContaining(["matrix-coding", "matrix-coding-reliable"]),
      )
      for (const entry of payload.data) {
        expect(entry.object).toBe("model")
        expect(entry.owned_by).toBe("matrix")
      }
    })
  })

  test("GET /v1/models rejects requests without a bearer token", async () => {
    const settings = baseSettings()
    await withApi(settings, async (listener) => {
      const response = await getJson(`${listener.url}/v1/models`)
      expect(response.status).toBe(401)
      const payload = await readJson<ErrorResponse>(response)
      expect(payload.error.type).toBe("authentication_error")
      expect(JSON.stringify(payload)).not.toContain(settings.apiKey!)
    })
  })

  test("GET /v1/models rejects requests with a wrong bearer token", async () => {
    const settings = baseSettings()
    await withApi(settings, async (listener) => {
      const response = await getJson(`${listener.url}/v1/models`, bearer("wrong-key-value-000"))
      expect(response.status).toBe(401)
    })
  })

  test("plain chat completion uses direct override when pool is empty", async () => {
    const stub = await stubServer("ok")
    try {
      const settings = baseSettings({
        directBaseURL: stub.url,
        directApiKey: "test-direct-key",
        omnirouteBaseURL: "https://omniroute.example/v1",
        poolEnv: { OPENROUTER_API_KEY: undefined, CEREBRAS_API_KEY: undefined },
      })
      await withApi(settings, async (listener) => {
        const response = await fetch(`${listener.url}/v1/chat/completions`, {
          method: "POST",
          headers: { ...bearer(settings.apiKey!), "content-type": "application/json" },
          body: JSON.stringify({ model: "matrix-coding", messages: [{ role: "user", content: "Say hi" }] }),
        })
        const payload = await readJson<ChatCompletionResponse>(response)
        expect(response.status).toBe(200)
        expect(payload.object).toBe("chat.completion")
        expect(payload.choices[0].message.content).toBe("Hello from Matrix API")
        expect(payload.choices[0].finish_reason).toBe("stop")
        expect(payload.model).toBe("matrix-coding")
        expect(payload.usage).toEqual({ prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 })
        expect(stub.record.count).toBe(1)
        expect(stub.record.headers["x-matrix-origin"]).toBe("matrix-api")
        expect(stub.record.headers["x-matrix-hop"]).toBe("1")
      })
    } finally {
      await closeServer(stub.server)
    }
  })

  test("an unknown model is rejected with a structured 404", async () => {
    const settings = baseSettings({ directBaseURL: "http://127.0.0.1:1" })
    await withApi(settings, async (listener) => {
      const response = await postChat(
        `${listener.url}/v1/chat/completions`,
        settings.apiKey!,
        JSON.stringify({ model: "made-up-model", messages: [{ role: "user", content: "hi" }] }),
      )
      const payload = await readJson<ErrorResponse>(response)
      expect(response.status).toBe(404)
      expect(payload.error.code).toBe("model_not_found")
      expect(payload.error.message).toContain("made-up-model")
    })
  })

  test("recursion is blocked structurally when the direct route is the OmniRoute gateway", async () => {
    const stub = await stubServer("ok")
    try {
      const settings = baseSettings({
        directBaseURL: stub.url,
        directApiKey: "test-direct-key",
        omnirouteBaseURL: stub.url,
        poolEnv: { OPENROUTER_API_KEY: undefined, CEREBRAS_API_KEY: undefined },
      })
      await withApi(settings, async (listener) => {
        const response = await postChat(`${listener.url}/v1/chat/completions`, settings.apiKey!)
        const payload = await readJson<ErrorResponse>(response)
        expect(response.status).toBe(400)
        expect(payload.error.type).toBe("recursion_error")
        expect(payload.error.code).toBe("no_safe_route")
        expect(payload.error.message.toLowerCase()).toContain("loop")
      })
      expect(stub.record.count).toBe(0)
    } finally {
      await closeServer(stub.server)
    }
  })

  test("hop guard blocks forged deep headers", async () => {
    const stub = await stubServer("ok")
    try {
      const settings = baseSettings({
        directBaseURL: stub.url,
        directApiKey: "test-direct-key",
        omnirouteBaseURL: "https://omniroute.example/v1",
        poolEnv: { OPENROUTER_API_KEY: undefined, CEREBRAS_API_KEY: undefined },
      })
      await withApi(settings, async (listener) => {
        const response = await postChat(
          `${listener.url}/v1/chat/completions`,
          settings.apiKey!,
          undefined,
          { "x-matrix-hop": "99" },
        )
        const payload = await readJson<ErrorResponse>(response)
        expect(response.status).toBe(400)
        expect(payload.error.type).toBe("recursion_error")
        expect(payload.error.code).toBe("hop_limit_exceeded")
      })
      expect(stub.record.count).toBe(0)
    } finally {
      await closeServer(stub.server)
    }
  })

  test("garbage hop headers are ignored, not treated as failures", async () => {
    const stub = await stubServer("ok")
    try {
      const settings = baseSettings({
        directBaseURL: stub.url,
        directApiKey: "test-direct-key",
        omnirouteBaseURL: "https://omniroute.example/v1",
        poolEnv: { OPENROUTER_API_KEY: undefined, CEREBRAS_API_KEY: undefined },
      })
      await withApi(settings, async (listener) => {
        const response = await postChat(
          `${listener.url}/v1/chat/completions`,
          settings.apiKey!,
          undefined,
          { "x-matrix-hop": "not-a-number" },
        )
        expect(response.status).toBe(200)
        expect(stub.record.headers["x-matrix-hop"]).toBe("1")
      })
    } finally {
      await closeServer(stub.server)
    }
  })

  test("malformed chat bodies are rejected with a structured 400", async () => {
    const settings = baseSettings({ directBaseURL: "http://127.0.0.1:1" })
    await withApi(settings, async (listener) => {
      const bodies = [
        '{"model":',
        JSON.stringify({ model: 123, messages: [] }),
        JSON.stringify({ model: "matrix-coding", messages: "nope" }),
        JSON.stringify({ model: "matrix-coding", messages: [42] }),
      ]
      for (const raw of bodies) {
        const response = await fetch(`${listener.url}/v1/chat/completions`, {
          method: "POST",
          headers: { ...bearer(settings.apiKey!), "content-type": "application/json" },
          body: raw,
        })
        expect(response.status).toBe(400)
        const payload = await readJson<ErrorResponse>(response)
        expect(payload.error.type).toBe("invalid_request_error")
        expect(payload.error.code).toBe("invalid_json")
      }
    })
  })

  test("upstream failures are sanitized and never leak provider secrets", async () => {
    const stub = await stubServer("error500")
    try {
      const settings = baseSettings({
        directBaseURL: stub.url,
        directApiKey: "test-direct-key",
        omnirouteBaseURL: "https://omniroute.example/v1",
        poolEnv: { OPENROUTER_API_KEY: "sk-test-openrouter", CEREBRAS_API_KEY: "csk-test-cerebras" },
      })
      await withApi(settings, async (listener) => {
        const response = await postChat(`${listener.url}/v1/chat/completions`, settings.apiKey!)
        const payload = await readJson<ErrorResponse>(response)
        expect([500, 502]).toContain(response.status)
        expect(payload.error.type).toBe("upstream_error")
        expect(JSON.stringify(payload)).not.toContain("sk-TESTREALAK31337")
      })
    } finally {
      await closeServer(stub.server)
    }
  })

  test("status endpoint reports configuration without exposing the key", async () => {
    const settings = baseSettings({
      directBaseURL: "http://127.0.0.1:1",
      poolEnv: { OPENROUTER_API_KEY: "sk-test-openrouter", CEREBRAS_API_KEY: "csk-test-cerebras" },
    })
    await withApi(settings, async (listener) => {
      const response = await getJson(`${listener.url}/v1/status`, bearer(settings.apiKey!))
      expect(response.status).toBe(200)
      const payload = await readJson<StatusResponse>(response)
      expect(payload.enabled).toBe(true)
      expect(payload.bindAddress).toBe("127.0.0.1:0")
      expect(payload.authentication).toBe("configured")
      expect(JSON.stringify(payload)).not.toContain(settings.apiKey!)
    })
  })

  test("unknown routes return a structured 404 that stays secret-free", async () => {
    const settings = baseSettings()
    await withApi(settings, async (listener) => {
      const response = await getJson(`${listener.url}/v1/admin`, bearer(settings.apiKey!))
      expect(response.status).toBe(404)
      const payload = await readJson<ErrorResponse>(response)
      expect(payload.error.type).toBe("invalid_request_error")
      expect(JSON.stringify(payload)).not.toContain(settings.apiKey!)
    })
  })

  test("no free pool candidate returns structured no_free_route error when no direct override", async () => {
    const settings = baseSettings({ poolEnv: { OPENROUTER_API_KEY: undefined, CEREBRAS_API_KEY: undefined } })
    await withApi(settings, async (listener) => {
      const response = await postChat(`${listener.url}/v1/chat/completions`, settings.apiKey!)
      const payload = await readJson<ErrorResponse>(response)
      expect(response.status).toBe(503)
      expect(payload.error.type).toBe("server_config_error")
      expect(payload.error.code).toBe("no_free_route")
      expect(payload.error.message).toContain("eligible")
    })
  })

  test("direct override is used when no free pool candidate is available", async () => {
    const stub = await stubServer("ok")
    try {
      const settings = baseSettings({
        poolEnv: { OPENROUTER_API_KEY: undefined, CEREBRAS_API_KEY: undefined },
        directBaseURL: stub.url,
        directApiKey: "test-direct-key",
        omnirouteBaseURL: "https://omniroute.example/v1",
      })
      await withApi(settings, async (listener) => {
        const response = await postChat(`${listener.url}/v1/chat/completions`, settings.apiKey!)
        expect(response.status).toBe(200)
        const payload = await readJson<ChatCompletionResponse>(response)
        expect(payload.choices[0].message.content).toBe("Hello from Matrix API")
      })
    } finally {
      await closeServer(stub.server)
    }
  })

  test("status endpoint includes pool and routing information without secrets", async () => {
    const settings = baseSettings({
      poolEnv: { OPENROUTER_API_KEY: "sk-secret-pool", CEREBRAS_API_KEY: "csk-test-cerebras" },
    })
    await withApi(settings, async (listener) => {
      const response = await getJson(`${listener.url}/v1/status`, bearer(settings.apiKey!))
      expect(response.status).toBe(200)
      const payload = await readJson<any>(response)
      expect(payload.pool).toBeDefined()
      expect(payload.pool.candidates).toBeDefined()
      expect(payload.pool.eligibleFree).toBeDefined()
      expect(payload.pool.rejectedOmniRouteBacked).toBeDefined()
      expect(payload.routing).toBeDefined()
      expect(payload.routing.lastSelected).toBeDefined()
      expect(payload.routing.fallbackCandidates).toBeDefined()
      const json = JSON.stringify(payload)
      expect(json).not.toContain("sk-secret-pool")
    })
  })

  test("start fails closed when the port is already taken", async () => {
    const blocker = await new Promise<Server>((resolve, reject) => {
      const server = createServer()
      server.once("error", reject)
      server.listen(0, "127.0.0.1", () => resolve(server))
    })
    try {
      const settings = baseSettings({ port: (blocker.address() as { port: number }).port, directBaseURL: "http://127.0.0.1:1" })
      const run = Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Effect.scope
          return yield* MatrixApiServer.start(settings, scope)
        }),
      )
      await expect(Effect.runPromise(run)).rejects.toThrow()
    } finally {
      await closeServer(blocker)
    }
  })
})
