import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { createServer, type IncomingMessage, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import type { Settings } from "./config"
import { freeAutoPool } from "./executor"
import { MatrixApiPool } from "./pool"
import { MatrixApiServer } from "./server"

type StubMode =
  | "success"
  | "400"
  | "400-model-unavailable"
  | "401-auth"
  | "401-model"
  | "403-opencode"
  | "402"
  | "429"
  | "429-retry-after"
  | "500"
  | "502"
  | "503"
  | "timeout"
  | "all-429"
  | "all-429-quota"
  | "all-503"

// The real OpenRouter free-account rejection, verbatim. It arrives as an
// ordinary HTTP 429, so the body is the only thing that separates a spent daily
// allowance from a transient rate limit.
const OPENROUTER_DAILY_QUOTA_MESSAGE =
  "Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day."

interface UpstreamRequest {
  readonly model: string
  readonly stream?: boolean
  readonly messages?: unknown
}

interface StubState {
  readonly requests: UpstreamRequest[]
  readonly headers: IncomingMessage["headers"][]
  firstModel?: string
  tags?: number
}

const baseSettings = (overrides: Partial<Settings> = {}): Settings => ({
  enabled: true,
  host: "127.0.0.1",
  port: 0,
  maxHops: 2,
  maxAttempts: 3,
  apiKey: "matrix-test-secret-key",
  ...overrides,
})

function withApi<T>(settings: Settings, run: (listener: { readonly url: string }) => Promise<T>): Promise<T> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const listener = yield* MatrixApiServer.listen(settings)
        return yield* Effect.tryPromise(() => run(listener))
      }),
    ),
  )
}

function postChat(url: string, key: string, stream = true, model = "matrix-coding-reliable", maxTokens?: number) {
  return fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream,
      messages: [{ role: "user", content: "hi" }],
      ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
    }),
  })
}

function postVision(url: string, key: string) {
  return fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "matrix-vision",
      stream: true,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Read it" },
            { type: "image_url", image_url: { url: "data:image/webp;base64,AQID" } },
          ],
        },
      ],
    }),
  })
}

function stubServer(
  mode: StubMode,
): Promise<{ readonly server: Server; readonly url: string; readonly state: StubState }> {
  const state: StubState = { requests: [], headers: [] }
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      if (request.url !== "/v1/chat/completions" && request.url !== "/chat/completions") {
        response.writeHead(404).end()
        return
      }
      let body = ""
      request.on("data", (chunk) => (body += chunk))
      request.on("end", () => {
        const input = JSON.parse(body) as UpstreamRequest
        state.requests.push(input)
        state.headers.push(request.headers)
        state.firstModel ??= input.model

        if (
          (input.model === state.firstModel ||
            mode === "all-429" ||
            mode === "all-429-quota" ||
            mode === "all-503" ||
            mode === "403-opencode") &&
          mode !== "success"
        ) {
          if (mode === "timeout") {
            response.destroy()
            return
          }
          const status =
            mode === "401-auth" || mode === "401-model"
              ? 401
              : mode === "403-opencode"
                ? 403
              : mode === "429-retry-after" || mode === "all-429" || mode === "all-429-quota"
                ? 429
                : mode === "all-503"
                  ? 503
                  : mode === "400-model-unavailable"
                    ? 400
                    : Number(mode)
          const message =
            mode === "401-model"
              ? "Model is not supported by this route"
              : mode === "401-auth"
                ? "Invalid API key"
                : mode === "403-opencode"
                  ? "OpenCode's free tier can only be used from within OpenCode"
                : mode === "402"
                  ? "Payment required"
                  : mode === "400"
                    ? "Invalid request payload"
                    : mode === "400-model-unavailable"
                      ? "Upstream request failed: Model is unavailable."
                      : mode === "all-429-quota"
                        ? OPENROUTER_DAILY_QUOTA_MESSAGE
                        : "recoverable failure"
          response.writeHead(status, {
            "content-type": "application/json",
            ...(mode === "429-retry-after" ? { "retry-after": "120" } : {}),
          })
          response.end(JSON.stringify({ error: { message } }))
          return
        }

        if (input.stream) {
          response.writeHead(200, { "content-type": "text/event-stream" })
          response.write('data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n')
          response.write('data: {"choices":[{"delta":{"content":"World"}}]}\n\n')
          response.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')
          response.end("data: [DONE]\n\n")
          return
        }

        response.writeHead(200, { "content-type": "application/json" })
        response.end(
          JSON.stringify({
            id: "stub-id",
            object: "chat.completion",
            created: 1234,
            model: input.model,
            choices: [{ message: { role: "assistant", content: "Non-stream response" }, finish_reason: "stop" }],
          }),
        )
      })
    })
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, state })
    })
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

function ollamaStub(mode: "success" | "503", capabilities: readonly string[] = ["tools"], port = 0, context = 32768) {
  const state: StubState = { requests: [], headers: [], tags: 0 }
  return new Promise<{ readonly server: Server; readonly url: string; readonly state: StubState }>(
    (resolve, reject) => {
      const server = createServer((request, response) => {
        if (request.url === "/api/tags") {
          state.tags = (state.tags ?? 0) + 1
          response.writeHead(200, { "content-type": "application/json" })
          response.end(JSON.stringify({ models: [{ name: "qwen3:8b" }] }))
          return
        }
        if (request.url === "/api/show") {
          response.writeHead(200, { "content-type": "application/json" })
          response.end(JSON.stringify({ capabilities, model_info: { "qwen3.context_length": context } }))
          return
        }
        if (request.url !== "/v1/chat/completions" && request.url !== "/chat/completions") {
          response.writeHead(404).end()
          return
        }
        let body = ""
        request.on("data", (chunk) => (body += chunk))
        request.on("end", () => {
          const input = JSON.parse(body) as UpstreamRequest
          state.requests.push(input)
          state.headers.push(request.headers)
          if (mode === "503") {
            response.writeHead(503, { "content-type": "application/json" })
            response.end(JSON.stringify({ error: { message: "local unavailable" } }))
            return
          }
          if (input.stream) {
            response.writeHead(200, { "content-type": "text/event-stream" })
            response.write('data: {"choices":[{"delta":{"content":"Local response"}}]}\n\n')
            response.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')
            response.end("data: [DONE]\n\n")
            return
          }
          response.writeHead(200, { "content-type": "application/json" })
          response.end(
            JSON.stringify({
              id: "stub-id",
              object: "chat.completion",
              created: 1234,
              model: input.model,
              choices: [{ message: { role: "assistant", content: "Non-stream response" }, finish_reason: "stop" }],
            }),
          )
        })
      })
      server.once("error", reject)
      server.listen(port, "127.0.0.1", () => {
        resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, state })
      })
    },
  )
}

function directFallbackSettings(url: string) {
  return baseSettings({
    poolEnv: { OPENROUTER_API_KEY: "openrouter-test", CEREBRAS_API_KEY: "cerebras-test" },
    poolBaseURLOverrides: {
      "openrouter/free": url,
      "openrouter/nemotron-3-ultra-free": url,
      "cerebras/glm-5-turbo": url,
    },
  })
}

async function unusedLocalPort() {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  await closeServer(server)
  return port
}

function omnirouteReliableSettings(url: string) {
  return baseSettings({
    omnirouteBaseURL: url,
    poolEnv: { OMNIROUTE_API_KEY: "omniroute-test-key" },
  })
}

function mixedReliableSettings(
  omnirouteURL: string,
  directURL: string,
  configured: { readonly openrouter?: boolean; readonly cerebras?: boolean } = {},
) {
  return baseSettings({
    omnirouteBaseURL: omnirouteURL,
    poolEnv: {
      OMNIROUTE_API_KEY: "omniroute-test-key",
      ...(configured.openrouter ? { OPENROUTER_API_KEY: "openrouter-test-key" } : {}),
      ...(configured.cerebras ? { CEREBRAS_API_KEY: "cerebras-test-key" } : {}),
    },
    poolBaseURLOverrides: {
      "openrouter/free": directURL,
      "openrouter/nemotron-3-ultra-free": directURL,
      "cerebras/glm-5-turbo": directURL,
    },
  })
}

// Local discovery is pointed at a closed port so a developer's running Ollama
// cannot add a candidate these assertions do not account for.
const NO_LOCAL_ROUTES = { ollamaBaseURL: "http://127.0.0.1:1" } as const

// OpenRouter is the only configured provider, and both of its free routes are
// real candidates for the Reliable profile.
function openRouterOnlySettings(url: string) {
  return baseSettings({
    ...NO_LOCAL_ROUTES,
    poolEnv: { OPENROUTER_API_KEY: "openrouter-test-key" },
    poolBaseURLOverrides: {
      "openrouter/free": url,
      "openrouter/nemotron-3-ultra-free": url,
    },
  })
}

// The exact shape of a real session request: a ~40KB system prompt, tool
// schemas, and the 32k output budget the session reserves. The API's context
// estimate adds the output reservation to the input estimate, so this request
// estimates to ~42k tokens — above the 32768 openrouter/free used to declare and
// well below the 200000 it actually has.
const AGENTIC_SYSTEM_PROMPT = "x".repeat(40_000)

function postAgentic(
  url: string,
  key: string,
  model = "matrix-coding-reliable",
  maxTokens = 32_000,
) {
  return fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: AGENTIC_SYSTEM_PROMPT },
        { role: "user", content: "List the files in the current directory." },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "bash",
            description: "Run a shell command",
            parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
          },
        },
        {
          type: "function",
          function: {
            name: "read",
            description: "Read a file",
            parameters: { type: "object", properties: { path: { type: "string" } } },
          },
        },
      ],
    }),
  })
}

// Both routes configured at once, which is the real deployment shape: a
// gateway URL, an independent direct override, and an OpenRouter credential.
// Merely configuring MATRIX_API_DIRECT_BASE_URL must not remove the gateway's
// Reliable candidates from the pool.
const INDEPENDENT_DIRECT_URL = "https://independent-provider.example/v1"

function bothRoutesSettings(omnirouteURL: string, directURL: string, openrouter = true) {
  return baseSettings({
    ...NO_LOCAL_ROUTES,
    omnirouteBaseURL: omnirouteURL,
    directBaseURL: INDEPENDENT_DIRECT_URL,
    poolEnv: {
      OMNIROUTE_API_KEY: "omniroute-test-key",
      ...(openrouter ? { OPENROUTER_API_KEY: "openrouter-test-key" } : {}),
    },
    poolBaseURLOverrides: {
      "openrouter/free": directURL,
      "openrouter/nemotron-3-ultra-free": directURL,
      "cerebras/glm-5-turbo": directURL,
    },
  })
}

const TEST_CREDENTIALS = [
  "openrouter-test-key",
  "cerebras-test-key",
  "omniroute-test-key",
  "matrix-test-secret-key",
] as const

async function errorPayload(response: Response) {
  const raw = await response.text()
  return { raw, payload: JSON.parse(raw) as { error: { code?: string; message: string; status: number } } }
}

async function routingStatus(url: string, key: string) {
  const response = await fetch(`${url}/v1/status`, { headers: { Authorization: `Bearer ${key}` } })
  return (await response.json()) as {
    readonly routing: {
      readonly candidates: ReadonlyArray<{
        readonly id: string
        readonly cooldownUntil: number
        readonly disabledReason?: string
      }>
    }
  }
}

describe("Matrix API OmniRoute path", () => {
  test("forwards the persisted gateway key and uses only auto/coding:free", async () => {
    const stub = await stubServer("success")
    try {
      const settings = baseSettings({
        omnirouteBaseURL: stub.url,
        poolEnv: { OMNIROUTE_API_KEY: "omniroute-test-key" },
      })
      await withApi(settings, async (listener) => {
        const response = await postChat(
          `${listener.url}/v1/chat/completions`,
          settings.apiKey!,
          false,
          "matrix-free-auto",
        )
        expect(response.status).toBe(200)
        expect(stub.state.requests).toHaveLength(1)
        expect(stub.state.requests[0]!.model).toBe("auto/coding:free")
        expect(stub.state.headers[0]!.authorization).toBe("Bearer omniroute-test-key")
      })
    } finally {
      await closeServer(stub.server)
    }
  })

  test("streams a successful free response", async () => {
    const stub = await stubServer("success")
    try {
      const settings = baseSettings({ omnirouteBaseURL: stub.url })
      await withApi(settings, async (listener) => {
        const response = await postChat(
          `${listener.url}/v1/chat/completions`,
          settings.apiKey!,
          true,
          "matrix-free-auto",
        )
        expect(response.status).toBe(200)
        expect(await response.text()).toContain("Hello ")
        expect(stub.state.requests[0]!.model).toBe("auto/coding:free")
      })
    } finally {
      await closeServer(stub.server)
    }
  })

  test("streams multimodal content only through the proven vision candidate", async () => {
    const stub = await stubServer("success")
    try {
      const settings = baseSettings({
        omnirouteBaseURL: stub.url,
        poolEnv: { OMNIROUTE_API_KEY: "omniroute-test-key" },
      })
      await withApi(settings, async (listener) => {
        const response = await postVision(`${listener.url}/v1/chat/completions`, settings.apiKey!)
        expect(response.status).toBe(200)
        expect(await response.text()).toContain("Hello ")
        expect(stub.state.requests).toHaveLength(1)
        expect(stub.state.requests[0]!.model).toBe("opencode/mimo-v2.5-free")
        expect(JSON.stringify(stub.state.requests[0]!.messages)).toContain("data:image/webp;base64,AQID")
      })
    } finally {
      await closeServer(stub.server)
    }
  })

  test("Free Auto fails fast with a sanitized error when OpenCode rejects external use", async () => {
    const stub = await stubServer("403-opencode")
    try {
      const settings = omnirouteReliableSettings(stub.url)
      await withApi(settings, async (listener) => {
        const response = await postChat(
          `${listener.url}/v1/chat/completions`,
          settings.apiKey!,
          false,
          "matrix-free-auto",
        )
        const payload = (await response.json()) as { error: { code: string; message: string } }
        expect(response.status).toBe(503)
        expect(stub.state.requests).toHaveLength(1)
        expect(payload.error.code).toBe("no_usable_provider")
        expect(payload.error.message).not.toContain("within OpenCode")
      })
    } finally {
      await closeServer(stub.server)
    }
  })
})

describe("Matrix reliable fallback", () => {
  test.each(["429", "503"] as const)("OmniRoute %s falls back to a compatible local Ollama model", async (mode) => {
    const cloud = await stubServer(mode)
    const local = await ollamaStub("success")
    try {
      const settings = { ...omnirouteReliableSettings(cloud.url), ollamaBaseURL: local.url }
      await withApi(settings, async (listener) => {
        const response = await postChat(`${listener.url}/v1/chat/completions`, settings.apiKey!, false)
        expect(response.status).toBe(200)
        expect(cloud.state.requests).toHaveLength(1)
        expect(local.state.requests.map((request) => request.model)).toEqual(["qwen3:8b"])
      })
    } finally {
      await closeServer(cloud.server)
      await closeServer(local.server)
    }
  })

  test("healthy cloud remains preferred over compatible local Ollama", async () => {
    const cloud = await stubServer("success")
    const local = await ollamaStub("success")
    try {
      const settings = { ...omnirouteReliableSettings(cloud.url), ollamaBaseURL: local.url }
      await withApi(settings, async (listener) => {
        expect((await postChat(`${listener.url}/v1/chat/completions`, settings.apiKey!, false)).status).toBe(200)
        expect(cloud.state.requests).toHaveLength(1)
        expect(local.state.requests).toHaveLength(0)
        expect(local.state.tags).toBe(1)
        expect((await postChat(`${listener.url}/v1/chat/completions`, settings.apiKey!, false)).status).toBe(200)
        expect(local.state.tags).toBe(1)
        const status = (await (
          await fetch(`${listener.url}/v1/status`, {
            headers: { Authorization: `Bearer ${settings.apiKey!}` },
          })
        ).json()) as {
          routing: {
            providers: { ollama: string; ollamaModels: number; independentInfrastructures: number }
          }
        }
        expect(status.routing.providers).toMatchObject({
          ollama: "available",
          ollamaModels: 1,
          independentInfrastructures: 2,
        })
      })
    } finally {
      await closeServer(cloud.server)
      await closeServer(local.server)
    }
  })

  test("rediscovers Ollama after TTL without restarting Matrix", async () => {
    const cloud = await stubServer("all-503")
    const port = await unusedLocalPort()
    const baseURL = `http://127.0.0.1:${port}`
    try {
      const settings = {
        ...omnirouteReliableSettings(cloud.url),
        ollamaBaseURL: baseURL,
        ollamaCacheTtlMs: 10,
      }
      await withApi(settings, async (listener) => {
        expect((await postChat(`${listener.url}/v1/chat/completions`, settings.apiKey!, false)).status).toBe(503)
        const local = await ollamaStub("success", ["tools"], port)
        try {
          await Bun.sleep(20)
          expect((await postChat(`${listener.url}/v1/chat/completions`, settings.apiKey!, false)).status).toBe(200)
          expect(local.state.tags).toBe(1)
          expect(local.state.requests.map((request) => request.model)).toEqual(["qwen3:8b"])
        } finally {
          await closeServer(local.server)
        }
      })
    } finally {
      await closeServer(cloud.server)
    }
  })

  test("Ollama without proven tool support is excluded from tool requests", async () => {
    const cloud = await stubServer("all-503")
    const local = await ollamaStub("success", ["completion"])
    try {
      const settings = { ...omnirouteReliableSettings(cloud.url), ollamaBaseURL: local.url }
      await withApi(settings, async (listener) => {
        const response = await fetch(`${listener.url}/v1/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${settings.apiKey!}`, "content-type": "application/json" },
          body: JSON.stringify({
            model: "matrix-coding-reliable",
            stream: false,
            messages: [{ role: "user", content: "run a tool" }],
            tools: [{ type: "function", function: { name: "bash", parameters: { type: "object" } } }],
          }),
        })
        expect(response.status).toBe(503)
        expect(local.state.requests).toHaveLength(0)
      })
    } finally {
      await closeServer(cloud.server)
      await closeServer(local.server)
    }
  })

  test("Ollama is excluded when the estimated request exceeds its known context", async () => {
    const cloud = await stubServer("all-503")
    const local = await ollamaStub("success")
    try {
      const settings = { ...omnirouteReliableSettings(cloud.url), ollamaBaseURL: local.url }
      await withApi(settings, async (listener) => {
        const response = await fetch(`${listener.url}/v1/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${settings.apiKey!}`, "content-type": "application/json" },
          body: JSON.stringify({
            model: "matrix-coding-reliable",
            stream: false,
            max_tokens: 40000,
            messages: [{ role: "user", content: "hi" }],
          }),
        })
        expect(response.status).toBe(503)
        expect(local.state.requests).toHaveLength(0)
      })
    } finally {
      await closeServer(cloud.server)
      await closeServer(local.server)
    }
  })

  test("large tool schemas count toward the local context estimate", async () => {
    const cloud = await stubServer("all-503")
    const local = await ollamaStub("success", ["tools"], 0, 100)
    try {
      const settings = { ...omnirouteReliableSettings(cloud.url), ollamaBaseURL: local.url }
      await withApi(settings, async (listener) => {
        const response = await fetch(`${listener.url}/v1/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${settings.apiKey!}`, "content-type": "application/json" },
          body: JSON.stringify({
            model: "matrix-coding-reliable",
            stream: false,
            messages: [{ role: "user", content: "use it" }],
            tools: [
              {
                type: "function",
                function: {
                  name: "large_tool",
                  description: "x".repeat(1000),
                  parameters: { type: "object", properties: {} },
                },
              },
            ],
          }),
        })
        expect(response.status).toBe(503)
        expect(local.state.requests).toHaveLength(0)
      })
    } finally {
      await closeServer(cloud.server)
      await closeServer(local.server)
    }
  })

  test("combines OmniRoute, OpenRouter, and Cerebras when both direct credentials exist", async () => {
    const omniroute = await stubServer("all-503")
    const direct = await stubServer("all-503")
    try {
      const settings = mixedReliableSettings(omniroute.url, direct.url, { openrouter: true, cerebras: true })
      await withApi(settings, async (listener) => {
        const response = await postChat(`${listener.url}/v1/chat/completions`, settings.apiKey!, false)
        expect(response.status).toBe(503)
        const requests = [...omniroute.state.requests, ...direct.state.requests]
        expect(requests).toHaveLength(3)
        expect(requests.some((request) => request.model.startsWith("opencode/"))).toBe(true)
        expect(requests.some((request) => request.model === "glm-5-turbo")).toBe(true)
        expect(requests.some((request) => request.model === "openrouter/free")).toBe(true)
      })
    } finally {
      await closeServer(omniroute.server)
      await closeServer(direct.server)
    }
  })

  test("OmniRoute 429 falls back to configured OpenRouter", async () => {
    const omniroute = await stubServer("429")
    const direct = await stubServer("success")
    try {
      const settings = mixedReliableSettings(omniroute.url, direct.url, { openrouter: true })
      await withApi(settings, async (listener) => {
        const response = await postChat(`${listener.url}/v1/chat/completions`, settings.apiKey!, false)
        expect(response.status).toBe(200)
        expect(omniroute.state.requests.map((request) => request.model)).toEqual(["opencode/big-pickle"])
        expect(direct.state.requests.map((request) => request.model)).toEqual(["openrouter/free"])
      })
    } finally {
      await closeServer(omniroute.server)
      await closeServer(direct.server)
    }
  })

  test("OmniRoute 503 falls back to configured Cerebras", async () => {
    const omniroute = await stubServer("503")
    const direct = await stubServer("success")
    try {
      const settings = mixedReliableSettings(omniroute.url, direct.url, { cerebras: true })
      await withApi(settings, async (listener) => {
        const response = await postChat(`${listener.url}/v1/chat/completions`, settings.apiKey!, false)
        expect(response.status).toBe(200)
        expect(omniroute.state.requests.map((request) => request.model)).toEqual(["opencode/big-pickle"])
        expect(direct.state.requests.map((request) => request.model)).toEqual(["glm-5-turbo"])
      })
    } finally {
      await closeServer(omniroute.server)
      await closeServer(direct.server)
    }
  })

  test("direct providers without credentials do not enter the mixed pool", async () => {
    const stub = await stubServer("429")
    try {
      const settings = mixedReliableSettings(stub.url, "http://127.0.0.1:1")
      await withApi(settings, async (listener) => {
        const response = await postChat(`${listener.url}/v1/chat/completions`, settings.apiKey!, false)
        expect(response.status).toBe(200)
        expect(stub.state.requests).toHaveLength(2)
        expect(stub.state.requests.every((request) => request.model.startsWith("opencode/"))).toBe(true)
      })
    } finally {
      await closeServer(stub.server)
    }
  })

  test("missing OpenRouter key excludes OpenRouter while configured Cerebras remains", async () => {
    const omniroute = await stubServer("503")
    const direct = await stubServer("success")
    try {
      const settings = mixedReliableSettings(omniroute.url, direct.url, { cerebras: true })
      await withApi(settings, async (listener) => {
        await postChat(`${listener.url}/v1/chat/completions`, settings.apiKey!, false)
        expect(direct.state.requests.some((request) => request.model === "glm-5-turbo")).toBe(true)
        expect(
          direct.state.requests.some((request) => request.model === "nvidia/nemotron-3-ultra-550b-a55b:free"),
        ).toBe(false)
        expect(direct.state.requests.some((request) => request.model === "openrouter/free")).toBe(false)
      })
    } finally {
      await closeServer(omniroute.server)
      await closeServer(direct.server)
    }
  })

  test("missing Cerebras key excludes Cerebras while configured OpenRouter remains", async () => {
    const omniroute = await stubServer("503")
    const direct = await stubServer("success")
    try {
      const settings = mixedReliableSettings(omniroute.url, direct.url, { openrouter: true })
      await withApi(settings, async (listener) => {
        await postChat(`${listener.url}/v1/chat/completions`, settings.apiKey!, false)
        expect(direct.state.requests.some((request) => request.model === "glm-5-turbo")).toBe(false)
        expect(direct.state.requests.some((request) => request.model === "openrouter/free")).toBe(true)
      })
    } finally {
      await closeServer(omniroute.server)
      await closeServer(direct.server)
    }
  })

  test("credential failure can switch once to a differently credentialed provider", async () => {
    const omniroute = await stubServer("401-auth")
    const direct = await stubServer("success")
    try {
      const settings = mixedReliableSettings(omniroute.url, direct.url, { openrouter: true })
      await withApi(settings, async (listener) => {
        const response = await postChat(`${listener.url}/v1/chat/completions`, settings.apiKey!, false)
        expect(response.status).toBe(200)
        expect(omniroute.state.requests.map((request) => request.model)).toEqual(["opencode/big-pickle"])
        expect(direct.state.requests.map((request) => request.model)).toEqual(["openrouter/free"])
      })
    } finally {
      await closeServer(omniroute.server)
      await closeServer(direct.server)
    }
  })

  test.each(["429", "503", "timeout"] as const)("%s moves to the next candidate without retry", async (mode) => {
    const stub = await stubServer(mode)
    try {
      const settings = directFallbackSettings(stub.url)
      await withApi(settings, async (listener) => {
        const response = await postChat(`${listener.url}/v1/chat/completions`, settings.apiKey!)
        expect(response.status).toBe(200)
        expect(await response.text()).toContain("Hello ")
        expect(stub.state.requests).toHaveLength(2)
        expect(stub.state.requests[0]!.model).not.toBe(stub.state.requests[1]!.model)
      })
    } finally {
      await closeServer(stub.server)
    }
  })

  test("stops after three distinct candidates when every infrastructure fails", async () => {
    const stub = await stubServer("all-503")
    try {
      const settings = omnirouteReliableSettings(stub.url)
      await withApi(settings, async (listener) => {
        const response = await postChat(`${listener.url}/v1/chat/completions`, settings.apiKey!, false)
        expect(response.status).toBe(503)
        expect(stub.state.requests).toHaveLength(3)
        expect(new Set(stub.state.requests.map((request) => request.model)).size).toBe(3)
      })
    } finally {
      await closeServer(stub.server)
    }
  })

  test("does not blindly fall back on a request-level 400", async () => {
    const stub = await stubServer("400")
    try {
      const settings = omnirouteReliableSettings(stub.url)
      await withApi(settings, async (listener) => {
        const response = await postChat(`${listener.url}/v1/chat/completions`, settings.apiKey!, false)
        expect(response.status).toBe(400)
        expect(stub.state.requests).toHaveLength(1)
      })
    } finally {
      await closeServer(stub.server)
    }
  })

  test("a request-level 400 does not fall back to the configured independent provider", async () => {
    const omniroute = await stubServer("400")
    const direct = await stubServer("success")
    try {
      const settings = mixedReliableSettings(omniroute.url, direct.url, { openrouter: true })
      await withApi(settings, async (listener) => {
        const response = await postChat(`${listener.url}/v1/chat/completions`, settings.apiKey!, false)
        expect(response.status).toBe(400)
        expect(omniroute.state.requests).toHaveLength(1)
        expect(direct.state.requests).toHaveLength(0)
      })
    } finally {
      await closeServer(omniroute.server)
      await closeServer(direct.server)
    }
  })

  test("an OmniRoute route in cooldown still leaves the configured independent provider usable", async () => {
    const omniroute = await stubServer("all-503")
    const direct = await stubServer("success")
    try {
      const settings = mixedReliableSettings(omniroute.url, direct.url, { openrouter: true })
      await withApi(settings, async (listener) => {
        const first = await postChat(`${listener.url}/v1/chat/completions`, settings.apiKey!, false)
        expect(first.status).toBe(200)
        expect(omniroute.state.requests).toHaveLength(1)
        expect(direct.state.requests.map((request) => request.model)).toEqual(["openrouter/free"])

        const status = await routingStatus(listener.url, settings.apiKey!)
        expect(status.routing.candidates.find((candidate) => candidate.cooldownUntil > Date.now())).toBeDefined()

        // The gateway route that just failed is cooling down. Cooldown and
        // disable state are per route and per infrastructure, so the direct
        // provider stays selectable instead of disappearing with the gateway.
        const second = await postChat(`${listener.url}/v1/chat/completions`, settings.apiKey!, false)
        expect(second.status).toBe(200)
        expect(omniroute.state.requests).toHaveLength(1)
        expect(direct.state.requests.map((request) => request.model)).toEqual(["openrouter/free", "openrouter/free"])
      })
    } finally {
      await closeServer(omniroute.server)
      await closeServer(direct.server)
    }
  })

  test("treats an upstream 400 model-is-unavailable as a route failure and uses the next provider", async () => {
    const omniroute = await stubServer("400-model-unavailable")
    const direct = await stubServer("success")
    try {
      const settings = mixedReliableSettings(omniroute.url, direct.url, { openrouter: true })
      await withApi(settings, async (listener) => {
        const response = await postChat(`${listener.url}/v1/chat/completions`, settings.apiKey!, false)
        expect(response.status).toBe(200)
        expect(omniroute.state.requests.map((request) => request.model)).toEqual(["opencode/big-pickle"])
        expect(direct.state.requests.map((request) => request.model)).toEqual(["openrouter/free"])
        const status = await routingStatus(listener.url, settings.apiKey!)
        expect(
          status.routing.candidates.find((candidate) => candidate.disabledReason === "model_not_supported"),
        ).toBeDefined()
      })
    } finally {
      await closeServer(omniroute.server)
      await closeServer(direct.server)
    }
  })

  test("OpenCode external-use 403 suppresses its infrastructure and falls back to OpenRouter", async () => {
    const omniroute = await stubServer("403-opencode")
    const direct = await stubServer("success")
    try {
      const settings = mixedReliableSettings(omniroute.url, direct.url, { openrouter: true })
      await withApi(settings, async (listener) => {
        const response = await postChat(`${listener.url}/v1/chat/completions`, settings.apiKey!, false)
        expect(response.status).toBe(200)
        expect(omniroute.state.requests).toHaveLength(1)
        expect(direct.state.requests.map((request) => request.model)).toEqual(["openrouter/free"])
      })
    } finally {
      await closeServer(omniroute.server)
      await closeServer(direct.server)
    }
  })

  test("OpenCode external-use 403 without an independent provider returns a sanitized error", async () => {
    const omniroute = await stubServer("403-opencode")
    try {
      const settings = omnirouteReliableSettings(omniroute.url)
      await withApi(settings, async (listener) => {
        const response = await postChat(`${listener.url}/v1/chat/completions`, settings.apiKey!, false)
        const payload = (await response.json()) as { error: { code: string; message: string } }
        expect(response.status).toBe(503)
        expect(omniroute.state.requests).toHaveLength(1)
        expect(payload.error.code).toBe("no_usable_provider")
        // Every gateway Reliable candidate sits on the suppressed OpenCode
        // infrastructure, so the message must report the real cause instead of
        // instructing the operator to configure a provider that is configured.
        expect(payload.error.message).toMatch(/configured: [1-9]\d*/)
        expect(payload.error.message).toContain("restricted_external_route")
        expect(payload.error.message).not.toContain("Configure OmniRoute")
        expect(payload.error.message).not.toContain("within OpenCode")
      })
    } finally {
      await closeServer(omniroute.server)
    }
  })

  test("does not treat a credential 401 as a route failure", async () => {
    const stub = await stubServer("401-auth")
    try {
      const settings = omnirouteReliableSettings(stub.url)
      await withApi(settings, async (listener) => {
        const response = await postChat(`${listener.url}/v1/chat/completions`, settings.apiKey!, false)
        expect(response.status).toBe(401)
        expect(stub.state.requests).toHaveLength(1)
      })
    } finally {
      await closeServer(stub.server)
    }
  })

  test("disables only an unsupported route and can use a sibling route", async () => {
    const stub = await stubServer("401-model")
    try {
      const settings = omnirouteReliableSettings(stub.url)
      await withApi(settings, async (listener) => {
        const response = await postChat(`${listener.url}/v1/chat/completions`, settings.apiKey!, false)
        expect(response.status).toBe(200)
        expect(stub.state.requests).toHaveLength(2)
        const status = await routingStatus(listener.url, settings.apiKey!)
        expect(
          status.routing.candidates.find((candidate) => candidate.disabledReason === "model_not_supported"),
        ).toBeDefined()
      })
    } finally {
      await closeServer(stub.server)
    }
  })

  test("respects Retry-After when cooling a rate-limited route", async () => {
    const stub = await stubServer("429-retry-after")
    try {
      const settings = omnirouteReliableSettings(stub.url)
      await withApi(settings, async (listener) => {
        const startedAt = Date.now()
        const response = await postChat(`${listener.url}/v1/chat/completions`, settings.apiKey!, false)
        expect(response.status).toBe(200)
        const status = await routingStatus(listener.url, settings.apiKey!)
        expect(
          status.routing.candidates.find((candidate) => candidate.cooldownUntil >= startedAt + 119_000),
        ).toBeDefined()
      })
    } finally {
      await closeServer(stub.server)
    }
  })
})

// The no-route error has to separate "the pool still has entries" from "an
// entry is selectable right now". Reporting only the pool size is what produced
// "eligible: 6" for a request no candidate could actually serve.
describe("Matrix no-route diagnostics", () => {
  test("reports pool, capability-compatible, and selectable counts separately", async () => {
    const stub = await stubServer("success")
    try {
      const settings = omnirouteReliableSettings(stub.url)
      await withApi(settings, async (listener) => {
        // max_tokens is part of the context estimate, so this request exceeds
        // every candidate's context window: all six entries stay in the pool
        // while none of them is capability-compatible.
        const response = await postChat(
          `${listener.url}/v1/chat/completions`,
          settings.apiKey!,
          false,
          "matrix-free-auto",
          1_500_000,
        )
        const payload = (await response.json()) as { error: { code: string; message: string } }
        expect(response.status).toBe(503)
        expect(payload.error.code).toBe("no_free_route")
        expect(payload.error.message).toContain("pool: 6")
        expect(payload.error.message).toContain("capability-compatible: 0")
        expect(payload.error.message).toContain("selectable: 0")
        expect(stub.state.requests).toHaveLength(0)
      })
    } finally {
      await closeServer(stub.server)
    }
  })
})

describe("Matrix Free Auto direct free fallback", () => {
  test("prefers the bundled OmniRoute free route while it succeeds", async () => {
    const omniroute = await stubServer("success")
    const direct = await stubServer("success")
    try {
      const settings = mixedReliableSettings(omniroute.url, direct.url, { openrouter: true, cerebras: true })
      await withApi(settings, async (listener) => {
        const response = await postChat(
          `${listener.url}/v1/chat/completions`,
          settings.apiKey!,
          false,
          "matrix-free-auto",
        )
        expect(response.status).toBe(200)
        expect(omniroute.state.requests.map((request) => request.model)).toEqual(["auto/coding:free"])
        expect(direct.state.requests).toHaveLength(0)
      })
    } finally {
      await closeServer(omniroute.server)
      await closeServer(direct.server)
    }
  })

  test("falls back to the configured OpenRouter free route when OmniRoute rejects external use", async () => {
    const omniroute = await stubServer("403-opencode")
    const direct = await stubServer("success")
    try {
      const settings = mixedReliableSettings(omniroute.url, direct.url, { openrouter: true })
      await withApi(settings, async (listener) => {
        const response = await postChat(
          `${listener.url}/v1/chat/completions`,
          settings.apiKey!,
          false,
          "matrix-free-auto",
        )
        expect(response.status).toBe(200)
        expect(omniroute.state.requests).toHaveLength(1)
        expect(direct.state.requests.map((request) => request.model)).toEqual(["openrouter/free"])
        expect(direct.state.headers[0]!.authorization).toBe("Bearer openrouter-test-key")
      })
    } finally {
      await closeServer(omniroute.server)
      await closeServer(direct.server)
    }
  })

  test("falls back to the configured Cerebras free route when OmniRoute is exhausted", async () => {
    const omniroute = await stubServer("403-opencode")
    const direct = await stubServer("success")
    try {
      const settings = mixedReliableSettings(omniroute.url, direct.url, { cerebras: true })
      await withApi(settings, async (listener) => {
        const response = await postChat(
          `${listener.url}/v1/chat/completions`,
          settings.apiKey!,
          false,
          "matrix-free-auto",
        )
        expect(response.status).toBe(200)
        expect(direct.state.requests.map((request) => request.model)).toEqual(["glm-5-turbo"])
        expect(direct.state.headers[0]!.authorization).toBe("Bearer cerebras-test-key")
      })
    } finally {
      await closeServer(omniroute.server)
      await closeServer(direct.server)
    }
  })

  test("excludes OpenRouter entirely when OPENROUTER_API_KEY is absent", async () => {
    const omniroute = await stubServer("403-opencode")
    const direct = await stubServer("success")
    try {
      const settings = mixedReliableSettings(omniroute.url, direct.url, { cerebras: true })
      await withApi(settings, async (listener) => {
        const response = await postChat(
          `${listener.url}/v1/chat/completions`,
          settings.apiKey!,
          false,
          "matrix-free-auto",
        )
        expect(response.status).toBe(200)
        expect(direct.state.requests.map((request) => request.model)).not.toContain("openrouter/free")
      })
    } finally {
      await closeServer(omniroute.server)
      await closeServer(direct.server)
    }
  })

  test("keeps the controlled no-usable-provider error when no free direct credential exists", async () => {
    const omniroute = await stubServer("all-503")
    const direct = await stubServer("success")
    try {
      const settings = mixedReliableSettings(omniroute.url, direct.url)
      await withApi(settings, async (listener) => {
        const response = await postChat(
          `${listener.url}/v1/chat/completions`,
          settings.apiKey!,
          false,
          "matrix-free-auto",
        )
        const payload = (await response.json()) as { error: { code: string } }
        expect(response.status).toBe(503)
        expect(payload.error.code).toBe("no_usable_provider")
        expect(direct.state.requests).toHaveLength(0)
      })
    } finally {
      await closeServer(omniroute.server)
      await closeServer(direct.server)
    }
  })

  test("never retries the OmniRoute infrastructure after falling back", async () => {
    const omniroute = await stubServer("403-opencode")
    const direct = await stubServer("403-opencode")
    try {
      const settings = mixedReliableSettings(omniroute.url, direct.url, { openrouter: true })
      await withApi(settings, async (listener) => {
        const response = await postChat(
          `${listener.url}/v1/chat/completions`,
          settings.apiKey!,
          false,
          "matrix-free-auto",
        )
        expect(response.status).toBe(503)
        expect(omniroute.state.requests).toHaveLength(1)
      })
    } finally {
      await closeServer(omniroute.server)
      await closeServer(direct.server)
    }
  })

  test("falls back to the configured OpenRouter free route when OmniRoute demands payment", async () => {
    const omniroute = await stubServer("402")
    const direct = await stubServer("success")
    try {
      const settings = mixedReliableSettings(omniroute.url, direct.url, { openrouter: true })
      await withApi(settings, async (listener) => {
        const response = await postChat(
          `${listener.url}/v1/chat/completions`,
          settings.apiKey!,
          false,
          "matrix-free-auto",
        )
        expect(response.status).toBe(200)
        expect(omniroute.state.requests.map((request) => request.model)).toEqual(["auto/coding:free"])
        expect(direct.state.requests.map((request) => request.model)).toEqual(["openrouter/free"])
      })
    } finally {
      await closeServer(omniroute.server)
      await closeServer(direct.server)
    }
  })

  test.each(["429", "502", "503"] as const)(
    "leaves the OmniRoute gateway for OpenRouter free after OmniRoute %s",
    async (mode) => {
      const omniroute = await stubServer(mode)
      const direct = await stubServer("success")
      try {
        const settings = mixedReliableSettings(omniroute.url, direct.url, { openrouter: true })
        await withApi(settings, async (listener) => {
          const response = await postChat(
            `${listener.url}/v1/chat/completions`,
            settings.apiKey!,
            false,
            "matrix-free-auto",
          )
          expect(response.status).toBe(200)
          expect(omniroute.state.requests.map((request) => request.model)).toEqual(["auto/coding:free"])
          expect(direct.state.requests.map((request) => request.model)).toEqual(["openrouter/free"])
        })
      } finally {
        await closeServer(omniroute.server)
        await closeServer(direct.server)
      }
    },
  )

  test("switches to the configured Cerebras free route after an OmniRoute rate limit", async () => {
    const omniroute = await stubServer("429")
    const direct = await stubServer("success")
    try {
      const settings = mixedReliableSettings(omniroute.url, direct.url, { cerebras: true })
      await withApi(settings, async (listener) => {
        const response = await postChat(
          `${listener.url}/v1/chat/completions`,
          settings.apiKey!,
          false,
          "matrix-free-auto",
        )
        expect(response.status).toBe(200)
        expect(omniroute.state.requests.map((request) => request.model)).toEqual(["auto/coding:free"])
        expect(direct.state.requests.map((request) => request.model)).toEqual(["glm-5-turbo"])
      })
    } finally {
      await closeServer(omniroute.server)
      await closeServer(direct.server)
    }
  })

  test("keeps trying the bundled OmniRoute siblings when no independent provider exists", async () => {
    const omniroute = await stubServer("all-503")
    const direct = await stubServer("success")
    try {
      const settings = mixedReliableSettings(omniroute.url, direct.url)
      await withApi(settings, async (listener) => {
        const response = await postChat(
          `${listener.url}/v1/chat/completions`,
          settings.apiKey!,
          false,
          "matrix-free-auto",
        )
        const payload = (await response.json()) as { error: { code: string } }
        const models = omniroute.state.requests.map((request) => request.model)
        // No independent provider is configured, so the availability guard must
        // not fire: every eligible bundled free candidate is still tried once.
        expect(models.length).toBeGreaterThan(1)
        expect(models[0]).toBe("auto/coding:free")
        expect(new Set(models).size).toBe(models.length)
        expect(response.status).toBe(503)
        expect(payload.error.code).toBe("no_usable_provider")
        expect(direct.state.requests).toHaveLength(0)
      })
    } finally {
      await closeServer(omniroute.server)
      await closeServer(direct.server)
    }
  })

  test("keeps matrix-vision on the proven OmniRoute vision candidate", async () => {
    const omniroute = await stubServer("success")
    const direct = await stubServer("success")
    try {
      const settings = mixedReliableSettings(omniroute.url, direct.url, { openrouter: true, cerebras: true })
      await withApi(settings, async (listener) => {
        const response = await postVision(`${listener.url}/v1/chat/completions`, settings.apiKey!)
        expect(response.status).toBe(200)
        expect(omniroute.state.requests.map((request) => request.model)).toEqual(["opencode/mimo-v2.5-free"])
        expect(direct.state.requests).toHaveLength(0)
      })
    } finally {
      await closeServer(omniroute.server)
      await closeServer(direct.server)
    }
  })

  test("offers only free candidates, OmniRoute first and without duplicate ids", () => {
    const settings = mixedReliableSettings("http://127.0.0.1:1", "http://127.0.0.1:2", {
      openrouter: true,
      cerebras: true,
    })
    const { preferred, eligible } = freeAutoPool(settings, MatrixApiPool.resolvePool(settings, settings.poolEnv))
    const ids = eligible.map((entry) => entry.candidate.id)

    expect(preferred.map((entry) => entry.candidate.id)).toEqual([
      "omniroute/matrix-free-coding",
      "omniroute/matrix-vision",
    ])
    expect(ids.slice(0, 2)).toEqual(preferred.map((entry) => entry.candidate.id))
    expect(ids).toContain("openrouter/free")
    expect(ids).toContain("cerebras/glm-5-turbo")
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).not.toContain("matrix-api/direct")
    expect(eligible.every((entry) => entry.free)).toBe(true)
    expect(eligible.every((entry) => entry.classification !== "DIRECT_AUTHENTICATED")).toBe(true)

    // Every other profile keeps the OmniRoute-only pool, so Free Auto's direct
    // free fallbacks never widen Vision or Coding.
    const { shared } = freeAutoPool(settings, MatrixApiPool.resolvePool(settings, settings.poolEnv))
    expect(shared.map((entry) => entry.candidate.id)).not.toContain("openrouter/free")
    expect(shared.map((entry) => entry.candidate.id)).not.toContain("cerebras/glm-5-turbo")
  })

  test("omits the direct free routes entirely when no direct credential is configured", () => {
    const settings = mixedReliableSettings("http://127.0.0.1:1", "http://127.0.0.1:2")
    const { eligible } = freeAutoPool(settings, MatrixApiPool.resolvePool(settings, settings.poolEnv))
    expect(eligible.map((entry) => entry.candidate.id)).toEqual([
      "omniroute/matrix-free-coding",
      "omniroute/matrix-vision",
      "omniroute/opencode-zen/big-pickle",
      "omniroute/opencode-zen/mimo-v2.5-free",
      "omniroute/opencode-zen/deepseek-v4-flash-free",
      "omniroute/opencode-zen/nemotron-3-ultra-free",
    ])
  })
})

describe("Matrix Free Auto strict free-only isolation", () => {
  test.each(["matrix-coding", "matrix-free-auto"])("%s preserves Retry-After across requests", async (model) => {
    const upstream = await stubServer("429-retry-after")
    try {
      const settings = baseSettings({
        ...NO_LOCAL_ROUTES,
        poolEnv: { OPENROUTER_API_KEY: "openrouter-test-key" },
        poolBaseURLOverrides: {
          "openrouter/free": upstream.url,
          "openrouter/nemotron-3-ultra-free": upstream.url,
        },
      })
      await withApi(settings, async (listener) => {
        const startedAt = Date.now()
        for (const round of [1, 2]) {
          const response = await postChat(`${listener.url}/v1/chat/completions`, settings.apiKey!, false, model)
          expect(response.status).toBe(200)
          await response.text()
          const status = await routingStatus(listener.url, settings.apiKey!)
          const route = status.routing.candidates.find((candidate) => candidate.id === "openrouter/free")
          expect(route?.cooldownUntil ?? 0).toBeGreaterThanOrEqual(startedAt + 120_000)
          expect(upstream.state.requests.filter((request) => request.model === "openrouter/free")).toHaveLength(1)
          expect(upstream.state.requests).toHaveLength(round + 1)
        }
      })
    } finally {
      await closeServer(upstream.server)
    }
  })

  for (const model of ["matrix-coding", "matrix-free-auto"]) {
    test.each(["tools", "context", "compatible"])(`${model} preserves %s eligibility during fallback`, async (mode) => {
      const first = await stubServer("all-503")
      const independent = await stubServer("success")
      const candidate = MatrixApiPool.POOL.find((entry) => entry.candidate.provider === "cerebras")!.candidate
      const original = { ...candidate }
      // Exercise the real executor with alternate provider metadata, restored
      // before the next test. No selection or transport implementation is mocked.
      Object.assign(candidate, {
        coding: 0,
        reasoning: 0,
        speed: 0,
        toolCalls: mode === "tools" ? 0 : 0.1,
        context: mode === "context" ? 1 : 200000,
      })
      try {
        const settings = baseSettings({
          ...NO_LOCAL_ROUTES,
          poolEnv: { OPENROUTER_API_KEY: "openrouter-test-key", CEREBRAS_API_KEY: "cerebras-test-key" },
          poolBaseURLOverrides: {
            "openrouter/free": first.url,
            "openrouter/nemotron-3-ultra-free": first.url,
            "cerebras/glm-5-turbo": independent.url,
          },
        })
        await withApi(settings, async (listener) => {
          const response = await fetch(`${listener.url}/v1/chat/completions`, {
            method: "POST",
            headers: { Authorization: `Bearer ${settings.apiKey}`, "content-type": "application/json" },
            body: JSON.stringify({
              model,
              stream: false,
              max_tokens: 256,
              messages: [{ role: "user", content: "Use the inspect tool." }],
              tools: [{ type: "function", function: { name: "inspect", parameters: { type: "object", properties: {} } } }],
            }),
          })
          expect(first.state.requests.length).toBeGreaterThan(0)
          if (mode === "compatible") {
            expect(response.status).toBe(200)
            expect(await response.text()).toContain("Hello World")
            expect(independent.state.requests).toHaveLength(1)
          } else {
            expect(response.status).toBe(503)
            expect((await errorPayload(response)).payload.error.code).toBe("no_usable_provider")
            expect(independent.state.requests).toHaveLength(0)
          }
        })
      } finally {
        Object.assign(candidate, original)
        await closeServer(first.server)
        await closeServer(independent.server)
      }
    })
  }

  test("rejects a paid-only configuration without contacting the override", async () => {
    const paid = await stubServer("success")
    try {
      const settings = baseSettings({
        ...NO_LOCAL_ROUTES,
        poolEnv: {},
        directBaseURL: paid.url,
        directApiKey: "paid-test-key",
      })
      await withApi(settings, async (listener) => {
        for (const stream of [false, true]) {
          const response = await postChat(`${listener.url}/v1/chat/completions`, settings.apiKey!, stream, "matrix-free-auto")
          const { raw, payload } = await errorPayload(response)
          expect(response.status).toBe(503)
          expect(payload.error.code).toBe("no_free_route")
          expect(payload.error.message).toContain("pool: 0, capability-compatible: 0, selectable: 0")
          expect(raw).not.toContain("paid-test-key")
          expect(paid.state.requests).toHaveLength(0)
        }
      })
    } finally {
      await closeServer(paid.server)
    }
  })

  test("uses the free route while a paid override is configured", async () => {
    const free = await stubServer("success")
    const paid = await stubServer("success")
    try {
      const settings = baseSettings({
        ...NO_LOCAL_ROUTES,
        poolEnv: { OPENROUTER_API_KEY: "openrouter-test-key" },
        directBaseURL: paid.url,
        directApiKey: "paid-test-key",
        poolBaseURLOverrides: {
          "openrouter/free": free.url,
          "openrouter/nemotron-3-ultra-free": free.url,
        },
      })
      await withApi(settings, async (listener) => {
        const response = await postChat(`${listener.url}/v1/chat/completions`, settings.apiKey!, false, "matrix-free-auto")
        expect(response.status).toBe(200)
        expect(await response.text()).toContain("Hello World")
        expect(free.state.requests.map((request) => request.model)).toEqual(["openrouter/free"])
        expect(paid.state.requests).toHaveLength(0)
      })
    } finally {
      await closeServer(free.server)
      await closeServer(paid.server)
    }
  })

  test.each(["matrix-coding", "matrix-coding-reliable"])("preserves the paid override for %s", async (model) => {
    const paid = await stubServer("success")
    try {
      const settings = baseSettings({
        ...NO_LOCAL_ROUTES,
        poolEnv: {},
        directBaseURL: paid.url,
        directApiKey: "paid-test-key",
      })
      await withApi(settings, async (listener) => {
        const response = await postChat(`${listener.url}/v1/chat/completions`, settings.apiKey!, false, model)
        expect(response.status).toBe(200)
        expect(await response.text()).toContain("Hello World")
        expect(paid.state.requests).toHaveLength(1)
      })
    } finally {
      await closeServer(paid.server)
    }
  })

  test.each(["direct", "gateway", "gateway-with-override"])(
    "requires explicit free metadata even for future entries in the %s pool",
    (mode) => {
      const settings = baseSettings({
        poolEnv: { OPENROUTER_API_KEY: "openrouter-test-key" },
        ...(mode === "direct" ? {} : { omnirouteBaseURL: "http://127.0.0.1:1" }),
        ...(mode === "gateway" ? {} : { directBaseURL: "http://127.0.0.1:2" }),
      })
      const resolved = MatrixApiPool.resolvePool(settings, settings.poolEnv)
      const paid = {
        ...resolved.free[0]!,
        candidate: { ...resolved.free[0]!.candidate, id: "future/paid", cost: 3 },
        free: false,
      }
      const unknown = { ...paid, candidate: { ...paid.candidate, id: "future/unknown", cost: 0 } }
      Reflect.deleteProperty(unknown, "free")
      // Deliberately contaminate the incoming pool: neither a DIRECT_FREE label
      // nor zero cost substitutes for an explicit free flag.
      const pool = freeAutoPool(settings, { ...resolved, free: [...resolved.free, paid, unknown] })
      expect(pool.eligible.length).toBeGreaterThan(0)
      expect([...pool.preferred, ...pool.eligible].every((entry) => entry.free === true)).toBe(true)
      expect(pool.eligible.map((entry) => entry.candidate.id)).not.toContain("future/paid")
      expect(pool.eligible.map((entry) => entry.candidate.id)).not.toContain("future/unknown")
    },
  )
})

// A real session sends ~40KB of system prompt and tool schemas with a 32k
// output budget. The context estimate below reserves that output inside the
// route's context window, so a route that declares 32768 was filtered out of
// every realistic request even while its credential was present and healthy.
describe("Matrix context eligibility for a realistic agentic request", () => {
  test("selects openrouter/free for a ~42k-token agentic request", async () => {
    const stub = await stubServer("success")
    try {
      const settings = openRouterOnlySettings(stub.url)
      await withApi(settings, async (listener) => {
        const response = await postAgentic(`${listener.url}/v1/chat/completions`, settings.apiKey!)
        expect(response.status).toBe(200)
        expect(stub.state.requests.map((request) => request.model)).toEqual(["openrouter/free"])
      })
    } finally {
      await closeServer(stub.server)
    }
  })

  test("still selects an OpenRouter route near the top of its real context window", async () => {
    const stub = await stubServer("success")
    try {
      const settings = openRouterOnlySettings(stub.url)
      await withApi(settings, async (listener) => {
        const response = await postAgentic(`${listener.url}/v1/chat/completions`, settings.apiKey!, "matrix-coding-reliable", 180_000)
        expect(response.status).toBe(200)
        expect(stub.state.requests).toHaveLength(1)
      })
    } finally {
      await closeServer(stub.server)
    }
  })

  test("rejects a genuinely oversized request instead of pretending the context is unlimited", async () => {
    const stub = await stubServer("success")
    try {
      const settings = openRouterOnlySettings(stub.url)
      await withApi(settings, async (listener) => {
        const response = await postAgentic(
          `${listener.url}/v1/chat/completions`,
          settings.apiKey!,
          "matrix-coding-reliable",
          200_000,
        )
        const { payload } = await errorPayload(response)
        expect(response.status).toBe(503)
        expect(payload.error.code).toBe("no_free_route")
        expect(payload.error.message).toContain("capability-compatible: 0")
        expect(stub.state.requests).toHaveLength(0)
      })
    } finally {
      await closeServer(stub.server)
    }
  })

  test("an agentic request falls back to the next eligible OpenRouter route after a recoverable failure", async () => {
    const stub = await stubServer("429")
    try {
      const settings = openRouterOnlySettings(stub.url)
      await withApi(settings, async (listener) => {
        const response = await postAgentic(`${listener.url}/v1/chat/completions`, settings.apiKey!)
        expect(response.status).toBe(200)
        expect(stub.state.requests.map((request) => request.model)).toEqual([
          "openrouter/free",
          "nvidia/nemotron-3-ultra-550b-a55b:free",
        ])
      })
    } finally {
      await closeServer(stub.server)
    }
  })

  test("a stale transient failure does not make the next agentic request report no_free_route", async () => {
    const stub = await stubServer("429")
    try {
      const settings = openRouterOnlySettings(stub.url)
      await withApi(settings, async (listener) => {
        const url = `${listener.url}/v1/chat/completions`
        expect((await postAgentic(url, settings.apiKey!)).status).toBe(200)

        // The first route is cooling down after the 429. An independent request
        // must route around it rather than fail as if no route existed.
        const second = await postAgentic(url, settings.apiKey!)
        expect(second.status).toBe(200)
        expect(stub.state.requests.map((request) => request.model)).toEqual([
          "openrouter/free",
          "nvidia/nemotron-3-ultra-550b-a55b:free",
          "nvidia/nemotron-3-ultra-550b-a55b:free",
        ])
      })
    } finally {
      await closeServer(stub.server)
    }
  })
})

// The old fixed message told the operator to configure OpenRouter while
// OpenRouter was the provider that had just answered and failed. These tests
// pin the replacement: the sanitized category, the status when it is safe to
// report, and the counts that separate "nothing configured" from "everything
// configured was tried and lost".
describe("Matrix exhausted-route diagnostics", () => {
  test("a configured OpenRouter that rate-limits every route reports rate_limit, not a missing credential", async () => {
    const stub = await stubServer("all-429")
    try {
      const settings = openRouterOnlySettings(stub.url)
      await withApi(settings, async (listener) => {
        const response = await postChat(`${listener.url}/v1/chat/completions`, settings.apiKey!, false)
        const { raw, payload } = await errorPayload(response)
        expect(response.status).toBe(503)
        expect(payload.error.code).toBe("no_usable_provider")
        expect(payload.error.status).toBe(503)
        expect(payload.error.message).toContain("configured: 2")
        expect(payload.error.message).toContain("attempted: 2")
        expect(payload.error.message).toContain("untried: 0")
        expect(payload.error.message).toContain("selectable: 0")
        expect(payload.error.message).toContain("Last failure: rate_limit (HTTP 429)")
        expect(payload.error.message).not.toContain("Configure OmniRoute")
        expect(payload.error.message).not.toContain("such as OpenRouter")
        for (const secret of TEST_CREDENTIALS) expect(raw).not.toContain(secret)
      })
    } finally {
      await closeServer(stub.server)
    }
  })

  test("a configured OpenRouter that answers 503 on every route reports upstream_failure", async () => {
    const stub = await stubServer("all-503")
    try {
      const settings = openRouterOnlySettings(stub.url)
      await withApi(settings, async (listener) => {
        const response = await postChat(`${listener.url}/v1/chat/completions`, settings.apiKey!, false)
        const { raw, payload } = await errorPayload(response)
        expect(response.status).toBe(503)
        expect(payload.error.code).toBe("no_usable_provider")
        expect(payload.error.message).toContain("configured: 2")
        expect(payload.error.message).toContain("Last failure: upstream_failure (HTTP 503)")
        expect(payload.error.message).not.toContain("Configure OmniRoute")
        for (const secret of TEST_CREDENTIALS) expect(raw).not.toContain(secret)
      })
    } finally {
      await closeServer(stub.server)
    }
  })

  test("an exhausted attempt budget reports the untried routes that remained selectable", async () => {
    const stub = await stubServer("502")
    try {
      const settings = { ...openRouterOnlySettings(stub.url), maxAttempts: 1 }
      await withApi(settings, async (listener) => {
        const response = await postChat(`${listener.url}/v1/chat/completions`, settings.apiKey!, false)
        const { payload } = await errorPayload(response)
        expect(response.status).toBe(503)
        expect(payload.error.code).toBe("no_usable_provider")
        expect(payload.error.message).toContain("configured: 2")
        expect(payload.error.message).toContain("attempted: 1")
        expect(payload.error.message).toContain("untried: 1")
        expect(payload.error.message).toContain("selectable: 1")
        expect(payload.error.message).toContain("Last failure: upstream_failure (HTTP 502)")
      })
    } finally {
      await closeServer(stub.server)
    }
  })

  test("no provider configured reports an empty pool rather than an exhausted one", async () => {
    // An explicit empty poolEnv: `resolvePool` falls back to the real
    // process environment when the snapshot is undefined.
    const settings = baseSettings({ ...NO_LOCAL_ROUTES, poolEnv: {} })
    await withApi(settings, async (listener) => {
      const response = await postChat(`${listener.url}/v1/chat/completions`, settings.apiKey!, false)
      const { raw, payload } = await errorPayload(response)
      expect(response.status).toBe(503)
      expect(payload.error.code).toBe("no_free_route")
      expect(payload.error.message).toContain("pool: 0")
      expect(payload.error.message).toContain("Configure OmniRoute or an authenticated free direct provider.")
      // Distinct from the configured-but-exhausted case: nothing was attempted.
      expect(payload.error.message).not.toContain("Last failure")
      for (const secret of TEST_CREDENTIALS) expect(raw).not.toContain(secret)
    })
  })
})

// MATRIX_API_DIRECT_BASE_URL used to act as a mode switch: setting it deleted
// every gateway-backed Reliable candidate from the pool, which is what turned
// "eligible: 6" into "eligible: 2" and left a single 429 with nothing to fall
// back to. It is documented as an optional fallback route, so it must add one
// without removing another infrastructure's routes.
describe("Matrix direct override and the gateway Reliable pool", () => {
  test("configuring the direct override does not remove the gateway from Reliable", async () => {
    const omniroute = await stubServer("success")
    const direct = await stubServer("success")
    try {
      const settings = bothRoutesSettings(omniroute.url, direct.url)
      await withApi(settings, async (listener) => {
        const response = await postChat(`${listener.url}/v1/chat/completions`, settings.apiKey!, false)
        expect(response.status).toBe(200)
        expect(omniroute.state.requests.map((request) => request.model)).toEqual(["opencode/big-pickle"])
        expect(direct.state.requests).toHaveLength(0)
      })
    } finally {
      await closeServer(omniroute.server)
      await closeServer(direct.server)
    }
  })

  test("the gateway's Reliable routes stay selectable when a direct override is configured", async () => {
    const omniroute = await stubServer("all-503")
    const direct = await stubServer("success")
    try {
      const settings = { ...bothRoutesSettings(omniroute.url, direct.url), maxAttempts: 1 }
      await withApi(settings, async (listener) => {
        const response = await postChat(`${listener.url}/v1/chat/completions`, settings.apiKey!, false)
        // The attempt budget is one, so this proves the gateway route was
        // selected first — the direct provider was never asked.
        expect(response.status).toBe(503)
        expect(omniroute.state.requests.map((request) => request.model)).toEqual(["opencode/big-pickle"])
        expect(direct.state.requests).toHaveLength(0)
      })
    } finally {
      await closeServer(omniroute.server)
      await closeServer(direct.server)
    }
  })

  test("keeps both the gateway and the independent providers in the Reliable set", () => {
    const settings = bothRoutesSettings("http://127.0.0.1:1", "http://127.0.0.1:2")
    const resolved = MatrixApiPool.resolvePool(settings, settings.poolEnv)
    const { omnirouteReliable, eligible } = freeAutoPool(settings, resolved)

    expect(omnirouteReliable).toHaveLength(4)
    expect(omnirouteReliable.every((entry) => entry.classification === "OMNIROUTE_BACKED")).toBe(true)
    expect(resolved.free.map((entry) => entry.candidate.id)).toEqual([
      "openrouter/free",
      "openrouter/nemotron-3-ultra-free",
    ])
    // Six Reliable candidates, not the two the mode switch left behind.
    expect(omnirouteReliable.length + resolved.free.length).toBe(6)

    // Free Auto's own pool shape is unchanged, and the paid override never
    // enters it while a free route exists.
    expect(eligible.map((entry) => entry.candidate.id)).not.toContain("matrix-api/direct")
    expect(eligible.every((entry) => entry.free)).toBe(true)
  })

  test("a direct override pointed back at the gateway is still refused as a loop", async () => {
    const stub = await stubServer("success")
    try {
      const settings = baseSettings({
        ...NO_LOCAL_ROUTES,
        omnirouteBaseURL: stub.url,
        directBaseURL: stub.url,
        poolEnv: { OMNIROUTE_API_KEY: "omniroute-test-key" },
      })
      await withApi(settings, async (listener) => {
        const response = await postChat(`${listener.url}/v1/chat/completions`, settings.apiKey!, false)
        const { payload } = await errorPayload(response)
        expect(response.status).toBe(400)
        expect(payload.error.code).toBe("no_safe_route")
        expect(payload.error.message).toContain("loop")
        expect(stub.state.requests).toHaveLength(0)
      })
    } finally {
      await closeServer(stub.server)
    }
  })
})

// A provider/account daily allowance is not a transient rate limit. The
// OpenRouter free-account rejection arrives as an HTTP 429, and treating it as
// one cooled the single route that answered, spent the next attempt on the
// sibling sharing the same exhausted account, and only then looked at another
// provider. These tests pin the replacement: the credential is remembered for
// the process, its remaining routes are skipped, and an independent provider is
// reached in the same request.
describe("Matrix daily provider quota exhaustion", () => {
  // OpenRouter (two routes, one credential) plus an independent Cerebras route.
  // Local discovery is pointed at a closed port so a developer's running Ollama
  // cannot take the fallback slot these assertions account for.
  function quotaMixedSettings(url: string) {
    return baseSettings({
      ...NO_LOCAL_ROUTES,
      poolEnv: { OPENROUTER_API_KEY: "openrouter-test-key", CEREBRAS_API_KEY: "cerebras-test-key" },
      poolBaseURLOverrides: {
        "openrouter/free": url,
        "openrouter/nemotron-3-ultra-free": url,
        "cerebras/glm-5-turbo": url,
      },
    })
  }

  // A scripted upstream: each model answers with the next step of its own list,
  // and the last step repeats. This is what lets one route be unavailable first
  // and healthy later, which is the real sequence a recovery follows.
  type ScriptedStep = "success" | "503" | "quota" | "rate-limit"

  function scriptedStub(script: Readonly<Record<string, readonly ScriptedStep[]>>) {
    const state: StubState = { requests: [], headers: [] }
    const counts = new Map<string, number>()
    return new Promise<{ readonly server: Server; readonly url: string; readonly state: StubState }>(
      (resolve, reject) => {
        const server = createServer((request, response) => {
          if (request.url !== "/v1/chat/completions" && request.url !== "/chat/completions") {
            response.writeHead(404).end()
            return
          }
          let body = ""
          request.on("data", (chunk) => (body += chunk))
          request.on("end", () => {
            const input = JSON.parse(body) as UpstreamRequest
            state.requests.push(input)
            state.headers.push(request.headers)
            const steps = script[input.model] ?? ["success"]
            const index = counts.get(input.model) ?? 0
            counts.set(input.model, index + 1)
            const step = steps[Math.min(index, steps.length - 1)]!
            if (step === "rate-limit") {
              response.writeHead(429, { "content-type": "application/json", "retry-after": "120" })
              response.end(JSON.stringify({ error: { message: "Too many requests" } }))
              return
            }
            if (step === "quota") {
              response.writeHead(429, { "content-type": "application/json" })
              response.end(JSON.stringify({ error: { message: OPENROUTER_DAILY_QUOTA_MESSAGE } }))
              return
            }
            if (step === "503") {
              response.writeHead(503, { "content-type": "application/json" })
              response.end(JSON.stringify({ error: { message: "upstream unavailable" } }))
              return
            }
            if (input.stream) {
              response.writeHead(200, { "content-type": "text/event-stream" })
              response.write('data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n')
              response.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')
              response.end("data: [DONE]\n\n")
              return
            }
            response.writeHead(200, { "content-type": "application/json" })
            response.end(
              JSON.stringify({
                id: "stub-id",
                object: "chat.completion",
                created: 1234,
                model: input.model,
                choices: [{ message: { role: "assistant", content: "Non-stream response" }, finish_reason: "stop" }],
              }),
            )
          })
        })
        server.once("error", reject)
        server.listen(0, "127.0.0.1", () => {
          resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, state })
        })
      },
    )
  }

  test.each(["matrix-coding", "matrix-free-auto", "matrix-coding-reliable"])(
    "%s never uses emergency fallback to bypass a previous Retry-After",
    async (model) => {
      const stub = await scriptedStub({
        "openrouter/free": ["rate-limit", "success"],
        "nvidia/nemotron-3-ultra-550b-a55b:free": ["success", "503"],
      })
      try {
        const settings = openRouterOnlySettings(stub.url)
        await withApi(settings, async (listener) => {
          const url = `${listener.url}/v1/chat/completions`
          const first = await postChat(url, settings.apiKey!, false, model)
          expect(first.status).toBe(200)
          await first.text()
          // The sibling now fails. The only untried route is the first route,
          // still under Retry-After; its scripted success must not be reached.
          const second = await postChat(url, settings.apiKey!, false, model)
          expect(second.status).toBe(503)
          expect((await errorPayload(second)).payload.error.code).toBe("no_usable_provider")
          expect(stub.state.requests.map((request) => request.model)).toEqual([
            "openrouter/free",
            "nvidia/nemotron-3-ultra-550b-a55b:free",
            "nvidia/nemotron-3-ultra-550b-a55b:free",
          ])
        })
      } finally {
        await closeServer(stub.server)
      }
    },
  )

  test("skips the sibling OpenRouter route and hands the request to Cerebras", async () => {
    const stub = await scriptedStub({
      // The independent provider is briefly unavailable, then recovers.
      "glm-5-turbo": ["503", "success"],
      // The first OpenRouter call is served; the daily allowance is spent by the
      // time the second one arrives.
      "openrouter/free": ["success", "quota"],
      // Shares the exhausted account, so it must never be asked.
      "nvidia/nemotron-3-ultra-550b-a55b:free": ["quota"],
    })
    try {
      const settings = quotaMixedSettings(stub.url)
      await withApi(settings, async (listener) => {
        const url = `${listener.url}/v1/chat/completions`
        // Cerebras is unavailable, so OpenRouter serves this request.
        const first = await postChat(url, settings.apiKey!, false)
        expect(first.status).toBe(200)

        // Cerebras is cooling down, so OpenRouter is asked first and reports the
        // spent daily allowance.
        const second = await postChat(url, settings.apiKey!, false)
        const raw = await second.text()
        expect(second.status).toBe(200)

        expect(stub.state.requests.map((request) => request.model)).toEqual([
          "glm-5-turbo",
          "openrouter/free",
          "openrouter/free",
          "glm-5-turbo",
        ])
        // The one route attempted in the quota request, then the independent
        // provider — the sibling on the exhausted account never appears.
        expect(stub.state.requests.slice(2).map((request) => request.model)).toEqual([
          "openrouter/free",
          "glm-5-turbo",
        ])
        for (const secret of TEST_CREDENTIALS) expect(raw).not.toContain(secret)
      })
    } finally {
      await closeServer(stub.server)
    }
  })

  test("with no independent provider, reports quota exhaustion and never asks the sibling", async () => {
    const stub = await stubServer("all-429-quota")
    try {
      const settings = openRouterOnlySettings(stub.url)
      await withApi(settings, async (listener) => {
        const response = await postChat(`${listener.url}/v1/chat/completions`, settings.apiKey!, false)
        const { raw, payload } = await errorPayload(response)
        expect(response.status).toBe(503)
        expect(payload.error.code).toBe("no_usable_provider")
        expect(payload.error.message).toContain("Last failure: quota_exhausted (HTTP 429)")
        expect(payload.error.message).toContain("Daily/provider quota is exhausted for 1 configured credential")
        // The credential is configured and answered: the old advice would be a
        // lie, and would have sent the operator looking for a missing key.
        expect(payload.error.message).not.toContain("Configure OmniRoute")
        expect(payload.error.message).not.toContain("missing")
        // One route contacted, one credential accounted for, sibling untouched.
        expect(stub.state.requests.map((request) => request.model)).toEqual(["openrouter/free"])
        expect(payload.error.message).toContain("attempted: 1")
        expect(payload.error.message).toContain("untried: 0")
        for (const secret of TEST_CREDENTIALS) expect(raw).not.toContain(secret)
      })
    } finally {
      await closeServer(stub.server)
    }
  })

  test("an ordinary transient 429 keeps its Retry-After cooldown and its sibling", async () => {
    const stub = await stubServer("429-retry-after")
    try {
      const settings = openRouterOnlySettings(stub.url)
      await withApi(settings, async (listener) => {
        const startedAt = Date.now()
        const url = `${listener.url}/v1/chat/completions`
        const first = await postChat(url, settings.apiKey!, false)
        expect(first.status).toBe(200)
        // No spent-allowance wording, so the sibling on the same credential is
        // still a candidate — that is what separates this from the quota case.
        expect(stub.state.requests.map((request) => request.model)).toEqual([
          "openrouter/free",
          "nvidia/nemotron-3-ultra-550b-a55b:free",
        ])
        const status = await routingStatus(listener.url, settings.apiKey!)
        const cooled = status.routing.candidates.find((candidate) => candidate.id === "openrouter/free")
        expect(cooled?.cooldownUntil ?? 0).toBeGreaterThanOrEqual(startedAt + 119_000)

        // The credential was never marked spent: after the cooldown the second
        // request still uses it.
        const second = await postChat(url, settings.apiKey!, false)
        expect(second.status).toBe(200)
        expect(stub.state.requests.map((request) => request.model)).toEqual([
          "openrouter/free",
          "nvidia/nemotron-3-ultra-550b-a55b:free",
          "nvidia/nemotron-3-ultra-550b-a55b:free",
        ])
      })
    } finally {
      await closeServer(stub.server)
    }
  })

  test("remembers the spent credential for the process without persisting it", async () => {
    const stub = await stubServer("all-429-quota")
    try {
      const settings = openRouterOnlySettings(stub.url)
      await withApi(settings, async (listener) => {
        const url = `${listener.url}/v1/chat/completions`
        const first = await postChat(url, settings.apiKey!, false)
        const firstPayload = await errorPayload(first)
        expect(firstPayload.payload.error.message).toContain("quota_exhausted")
        expect(firstPayload.payload.error.message).toContain("quota is exhausted")
        expect(stub.state.requests.map((request) => request.model)).toEqual(["openrouter/free"])

        // Same process: the credential is remembered, so not even the sibling is
        // contacted again — the request fails without another upstream call.
        const second = await postChat(url, settings.apiKey!, false)
        const secondPayload = await errorPayload(second)
        expect(second.status).toBe(503)
        expect(secondPayload.payload.error.code).toBe("no_free_route")
        expect(secondPayload.payload.error.message).toContain(
          "Daily/provider quota is exhausted for 1 configured credential",
        )
        expect(secondPayload.payload.error.message).not.toContain("Configure OmniRoute")
        expect(stub.state.requests).toHaveLength(1)
      })

      // A new executor is a new process: nothing was written down, so OpenRouter
      // is a normal candidate again rather than permanently disabled.
      const fresh = await stubServer("all-429-quota")
      try {
        const freshSettings = openRouterOnlySettings(fresh.url)
        await withApi(freshSettings, async (freshListener) => {
          await postChat(`${freshListener.url}/v1/chat/completions`, freshSettings.apiKey!, false)
          expect(fresh.state.requests.map((request) => request.model)).toEqual(["openrouter/free"])
        })
      } finally {
        await closeServer(fresh.server)
      }
    } finally {
      await closeServer(stub.server)
    }
  })

  test("Free Auto never leaks a configured paid override when the free quota is spent", async () => {
    const free = await stubServer("all-429-quota")
    const paid = await stubServer("success")
    try {
      const settings = baseSettings({
        ...NO_LOCAL_ROUTES,
        directBaseURL: paid.url,
        poolEnv: { OPENROUTER_API_KEY: "openrouter-test-key" },
        poolBaseURLOverrides: {
          "openrouter/free": free.url,
          "openrouter/nemotron-3-ultra-free": free.url,
        },
      })
      await withApi(settings, async (listener) => {
        const url = `${listener.url}/v1/chat/completions`
        const response = await postChat(url, settings.apiKey!, false, "matrix-free-auto")
        const { raw, payload } = await errorPayload(response)
        expect(response.status).toBe(503)
        expect(payload.error.code).toBe("no_usable_provider")
        expect(payload.error.message).toContain("quota is exhausted")
        // Free Auto stays free-only: the exhausted free credential does not open
        // the paid direct override, and the sibling free route is skipped.
        expect(free.state.requests.map((request) => request.model)).toEqual(["openrouter/free"])
        expect(paid.state.requests).toHaveLength(0)
        for (const secret of TEST_CREDENTIALS) expect(raw).not.toContain(secret)

        const again = await postChat(url, settings.apiKey!, false, "matrix-free-auto")
        expect(again.status).toBe(503)
        expect(free.state.requests).toHaveLength(1)
        expect(paid.state.requests).toHaveLength(0)
      })
    } finally {
      await closeServer(free.server)
      await closeServer(paid.server)
    }
  })
})
