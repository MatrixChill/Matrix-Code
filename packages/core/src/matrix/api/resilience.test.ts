import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { createServer, type IncomingMessage, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import type { Settings } from "./config"
import { MatrixApiServer } from "./server"

type StubMode = "success" | "429" | "503" | "timeout"

interface UpstreamRequest {
  readonly model: string
  readonly stream?: boolean
}

interface StubState {
  readonly requests: UpstreamRequest[]
  readonly headers: IncomingMessage["headers"][]
  firstModel?: string
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

function postChat(url: string, key: string, stream = true) {
  return fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "matrix-coding-reliable",
      stream,
      messages: [{ role: "user", content: "hi" }],
    }),
  })
}

function stubServer(mode: StubMode): Promise<{ readonly server: Server; readonly url: string; readonly state: StubState }> {
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

        if (input.model === state.firstModel && mode !== "success") {
          if (mode === "timeout") {
            response.destroy()
            return
          }
          response.writeHead(Number(mode), { "content-type": "application/json" })
          response.end(JSON.stringify({ error: { message: "recoverable failure" } }))
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
            choices: [
              { message: { role: "assistant", content: "Non-stream response" }, finish_reason: "stop" },
            ],
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

function directFallbackSettings(url: string) {
  return baseSettings({
    poolEnv: { OPENROUTER_API_KEY: "openrouter-test", CEREBRAS_API_KEY: "cerebras-test" },
    poolBaseURLOverrides: {
      "openrouter/nemotron-3-ultra-free": url,
      "cerebras/glm-5-turbo": url,
    },
  })
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
        const response = await postChat(`${listener.url}/v1/chat/completions`, settings.apiKey!, false)
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
        const response = await postChat(`${listener.url}/v1/chat/completions`, settings.apiKey!)
        expect(response.status).toBe(200)
        expect(await response.text()).toContain("Hello ")
        expect(stub.state.requests[0]!.model).toBe("auto/coding:free")
      })
    } finally {
      await closeServer(stub.server)
    }
  })
})

describe("Matrix reliable fallback", () => {
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
})
