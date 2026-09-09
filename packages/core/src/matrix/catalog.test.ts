import { describe, expect, test } from "bun:test"
import { MatrixCatalog } from "./catalog"

describe("MatrixCatalog.CATALOG", () => {
  test("uses the gateway wire id as candidate model so router recording matches", () => {
    const models = Object.fromEntries(MatrixCatalog.CATALOG.map((c) => [c.model, c.id]))
    expect(models["auto"]).toBe("omniroute/matrix-auto")
    expect(models["auto/fast"]).toBe("omniroute/matrix-auto-fast")
    expect(models["auto/coding:free"]).toBe("omniroute/matrix-free-coding")
    expect(models["matrix/matrix-coding"]).toBe("omniroute/matrix-coding")
    expect(models["matrix/matrix-coding-reliable"]).toBe("omniroute/matrix-coding-reliable")
  })

  test("vision candidate is separate and uses the gateway vision route", () => {
    const vision = MatrixCatalog.VISION_CANDIDATES[0]!
    expect(vision.id).toBe("omniroute/matrix-vision")
    expect(vision.model).toBe("auto/vision")
    expect(vision.vision).toBe(true)
  })
})

describe("MatrixCatalog.fromGatewayModels", () => {
  test("reuses tuned metadata for known routes", () => {
    const models = MatrixCatalog.fromGatewayModels([
      { id: "auto" },
      { id: "matrix/matrix-coding", name: "Matrix Coding" },
    ])
    expect(models).toHaveLength(2)
    const auto = models.find((c) => c.model === "auto")!
    expect(auto.id).toBe("omniroute/matrix-auto")
    expect(auto.toolCalls).toBe(0.7)
    const coding = models.find((c) => c.model === "matrix/matrix-coding")!
    expect(coding.id).toBe("omniroute/matrix-coding")
    expect(coding.toolCalls).toBe(0.85)
    expect(coding.name).toBe("Matrix Coding")
  })

  test("synthesizes routable candidates for unknown models", () => {
    const models = MatrixCatalog.fromGatewayModels([
      { id: "aug/best-reasoning", context: 200000, vision: true },
      { id: "tllm-something-fast" },
    ])
    expect(models).not.toHaveLength(0)
    const reasoning = models.find((c) => c.model === "aug/best-reasoning")!
    expect(reasoning.provider).toBe("omniroute")
    expect(reasoning.context).toBe(200000)
    expect(reasoning.vision).toBe(true)
    const fast = models.find((c) => c.model === "tllm-something-fast")!
    expect(fast.speed).toBe(0.9)
  })

  test("deduplicates ids and skips empty ids", () => {
    const models = MatrixCatalog.fromGatewayModels([{ id: "auto" }, { id: "auto" }, { id: "  " }, { id: "" }])
    const auto = models.filter((c) => c.model === "auto")
    expect(auto).toHaveLength(1)
  })

  test("keeps gateway context and name on known routes when advertised", () => {
    const models = MatrixCatalog.fromGatewayModels([
      { id: "auto/fast", name: "Auto Fast Route", context: 262144 },
    ])
    const fast = models[0]!
    expect(fast.name).toBe("Auto Fast Route")
    expect(fast.context).toBe(262144)
  })
})
