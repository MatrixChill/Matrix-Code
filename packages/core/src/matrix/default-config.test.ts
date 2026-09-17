import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

describe("Windows default config template", () => {
  const templatePath = path.resolve(
    import.meta.dirname,
    "../../../../distribution/windows/templates/opencode.omniroute.jsonc",
  )

  test("default model routes through Matrix API (matrix-api/matrix-free-auto)", () => {
    const raw = readFileSync(templatePath, "utf8")
    const json = JSON.parse(raw)
    expect(json.model).toBe("matrix-api/matrix-free-auto")
  })

  test("matrix-api provider is configured with Matrix API baseURL", () => {
    const raw = readFileSync(templatePath, "utf8")
    const json = JSON.parse(raw)
    expect(json.provider["matrix-api"]).toBeDefined()
    expect(json.provider["matrix-api"].options.baseURL).toBe("http://127.0.0.1:20260/v1")
  })

  test("direct omniroute models are still available for manual selection", () => {
    const raw = readFileSync(templatePath, "utf8")
    const json = JSON.parse(raw)
    expect(json.provider.omniroute).toBeDefined()
    expect(json.provider.omniroute.models["auto-coding-free"]).toBeDefined()
    expect(json.provider.omniroute.models["vision-free"]).toBeDefined()
  })
})
