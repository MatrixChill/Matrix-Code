import { afterEach, describe, expect, test } from "bun:test"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { MatrixLocalProvider } from "./local-provider"

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

async function stub(models: readonly string[], details: Record<string, unknown> = {}) {
  const state = { tags: 0, show: 0 }
  const server = createServer((request, response) => {
    if (request.url === "/api/tags") {
      state.tags++
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ models: models.map((name) => ({ name })) }))
      return
    }
    if (request.url === "/api/show") {
      state.show++
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify(details))
      return
    }
    response.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  servers.push(server)
  return { baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, state }
}

describe("Matrix Ollama local provider discovery", () => {
  test("offline and online-without-models both return an empty route list", async () => {
    expect(await MatrixLocalProvider.discover({ baseURL: "http://127.0.0.1:1", timeoutMs: 20 })).toEqual([])
    const online = await stub([])
    expect(await MatrixLocalProvider.discover({ baseURL: online.baseURL })).toEqual([])
  })

  test("creates conservative local routes from proven Ollama metadata", async () => {
    const online = await stub(["qwen3:8b"], {
      capabilities: ["completion", "tools"],
      model_info: { "qwen3.context_length": 32768 },
    })
    const routes = await MatrixLocalProvider.discover({ baseURL: online.baseURL })
    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({
      baseURL: `${online.baseURL}/v1`,
      keyEnv: "",
      classification: "LOCAL",
      candidate: {
        id: "ollama/qwen3:8b",
        provider: "ollama",
        infrastructureId: "ollama-local",
        toolCalls: 0.6,
        vision: false,
        context: 32768,
        profiles: ["reliable"],
      },
    })
  })

  test("does not invent tool, vision, or context capabilities", async () => {
    const online = await stub(["unknown:latest"], { capabilities: ["completion"] })
    const route = (await MatrixLocalProvider.discover({ baseURL: online.baseURL }))[0]!
    expect(route.candidate).toMatchObject({ toolCalls: 0, vision: false, context: -1, profiles: [] })
  })

  test("requires both proven tools and known context for automatic Reliable eligibility", async () => {
    const unknownContext = await stub(["tools-unknown"], { capabilities: ["tools"] })
    const noTools = await stub(["known-no-tools"], {
      capabilities: ["completion"],
      model_info: { "model.context_length": 8192 },
    })
    expect((await MatrixLocalProvider.discover({ baseURL: unknownContext.baseURL }))[0]?.candidate.profiles).toEqual([])
    expect((await MatrixLocalProvider.discover({ baseURL: noTools.baseURL }))[0]?.candidate.profiles).toEqual([])
  })

  test("short timeout aborts an unresponsive probe", async () => {
    const server = createServer(() => undefined)
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    servers.push(server)
    const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const started = performance.now()
    expect(await MatrixLocalProvider.discover({ baseURL, timeoutMs: 20 })).toEqual([])
    expect(performance.now() - started).toBeLessThan(500)
  })

  test("cache avoids repeated probes and expires for rediscovery", async () => {
    const online = await stub(["qwen3:8b"], { capabilities: ["tools"] })
    let now = 100
    const options = { baseURL: online.baseURL, ttlMs: 30, now: () => now }
    await MatrixLocalProvider.discover(options)
    await MatrixLocalProvider.discover(options)
    expect(online.state.tags).toBe(1)
    now = 131
    await MatrixLocalProvider.discover(options)
    expect(online.state.tags).toBe(2)
  })
})
