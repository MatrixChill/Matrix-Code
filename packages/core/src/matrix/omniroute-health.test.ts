import { describe, expect, test } from "bun:test"
import { createServer, type Server } from "node:http"
import { MatrixOmniRouteHealth } from "./omniroute-health"

function stubModels(payload: unknown, status = 200): Promise<{ server: Server; url: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer((_req, res) => {
      res.writeHead(status, { "content-type": "application/json" })
      res.end(JSON.stringify(payload))
    })
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` })
    })
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

describe("MatrixOmniRouteHealth.listModels", () => {
  test("parses the OpenAI-style model list with vision and context", async () => {
    const { server, url } = await stubModels({
      data: [
        { id: "auto", name: "Auto", context_length: 131072 },
        { id: "auto/vision", modalities: { output: ["text", "image"] } },
        { id: "weird/entry" },
      ],
    })
    try {
      const result = await MatrixOmniRouteHealth.listModels(url)
      expect(result?.models.map((m) => m.id)).toEqual(["auto", "auto/vision", "weird/entry"])
      expect(result!.models[0]!.context).toBe(131072)
      expect(result!.models[0]!.name).toBe("Auto")
      expect(result!.models[1]!.vision).toBe(true)
    } finally {
      await closeServer(server)
    }
  })

  test("returns undefined on non-2xx status", async () => {
    const { server, url } = await stubModels({ error: { message: "no" } }, 500)
    try {
      const result = await MatrixOmniRouteHealth.listModels(url)
      expect(result).toBeUndefined()
    } finally {
      await closeServer(server)
    }
  })

  test("returns undefined on a malformed body", async () => {
    const { server, url } = await stubModels({ not: "data" })
    try {
      const result = await MatrixOmniRouteHealth.listModels(url)
      expect(result).toBeUndefined()
    } finally {
      await closeServer(server)
    }
  })

  test("skips entries without an id", async () => {
    const { server, url } = await stubModels({ data: [{ id: "ok" }, { name: "no id" }, {}] })
    try {
      const result = await MatrixOmniRouteHealth.listModels(url)
      expect(result?.models.map((m) => m.id)).toEqual(["ok"])
    } finally {
      await closeServer(server)
    }
  })
})

describe("MatrixOmniRouteHealth.probe", () => {
  test("marks a reachable gateway online with its status code", async () => {
    const { server, url } = await stubModels({ data: [] })
    try {
      const result = await MatrixOmniRouteHealth.probe(url)
      expect(result.reachable).toBe(true)
      expect(result.statusCode).toBe(200)
    } finally {
      await closeServer(server)
    }
  })

  test("marks an unreachable gateway offline", async () => {
    const result = await MatrixOmniRouteHealth.probe("http://127.0.0.1:1")
    expect(result.reachable).toBe(false)
    expect(result.error).toBeDefined()
  })
})