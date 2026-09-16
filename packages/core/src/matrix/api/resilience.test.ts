import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { createServer, type IncomingMessage, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import type { Settings } from "./config"
import { MatrixApiServer } from "./server"

type StubMode =
  | "success"
  | "400"
  | "401-auth"
  | "401-model"
  | "402"
  | "429"
  | "429-retry-after"
  | "500"
  | "503"
  | "timeout"
  | "all-503"

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

function postChat(url: string, key: string, stream = true, model = "matrix-coding-reliable") {
  return fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream,
      messages: [{ role: "user", content: "hi" }],
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

        if ((input.model === state.firstModel || mode === "all-503") && mode !== "success") {
          if (mode === "timeout") {
            response.destroy()
            return
          }
          const status =
            mode === "401-auth" || mode === "401-model"
              ? 401
              : mode === "429-retry-after"
                ? 429
                : mode === "all-503"
                  ? 503
                  : Number(mode)
          const message =
            mode === "401-model"
              ? "Model is not supported by this route"
              : mode === "401-auth"
                ? "Invalid API key"
                : mode === "402"
                  ? "Payment required"
                  : mode === "400"
                    ? "Invalid request payload"
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
      "openrouter/nemotron-3-ultra-free": directURL,
      "cerebras/glm-5-turbo": directURL,
    },
  })
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
        expect(requests.some((request) => request.model === "nvidia/nemotron-3-ultra-550b-a55b:free")).toBe(true)
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
        expect(direct.state.requests.map((request) => request.model)).toEqual([
          "nvidia/nemotron-3-ultra-550b-a55b:free",
        ])
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
        expect(
          direct.state.requests.some((request) => request.model === "nvidia/nemotron-3-ultra-550b-a55b:free"),
        ).toBe(true)
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
        expect(direct.state.requests.map((request) => request.model)).toEqual([
          "nvidia/nemotron-3-ultra-550b-a55b:free",
        ])
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
