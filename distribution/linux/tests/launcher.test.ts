import { describe, expect, test } from "bun:test"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const launcher = await Bun.file(path.join(root, "matrix.sh")).text()
const template = await Bun.file(path.join(root, "templates", "opencode.omniroute.jsonc")).text()

describe("Linux portable launcher", () => {
  test("uses portable paths and private local state", () => {
    expect(launcher.startsWith("#!/bin/sh\n")).toBe(true)
    expect(launcher).toContain("set -eu")
    expect(launcher).toContain("umask 077")
    expect(launcher).toContain('matrix_home="$matrix_root/.matrix"')
    expect(launcher).toContain('export OPENCODE_CONFIG_DIR="$XDG_CONFIG_HOME/opencode"')
    expect(launcher).toContain('chmod 700 "$matrix_home"')
    expect(launcher).toContain('chmod 600 "$secret_tmp"')
  })

  test("keeps credentials out of process arguments and output", () => {
    expect(launcher).toContain("export OMNIROUTE_API_KEY STORAGE_ENCRYPTION_KEY REQUIRE_API_KEY=true")
    expect(launcher).toContain("export MATRIX_API_ENABLED=true MATRIX_API_KEY")
    expect(launcher).not.toMatch(/printf[^\n]*(OMNIROUTE_API_KEY|MATRIX_API_KEY|STORAGE_ENCRYPTION_KEY)/)
    expect(launcher).not.toMatch(/matrix_bin[^\n]*(--api-key|--token)/)
    expect(launcher).not.toMatch(/node_bin[^\n]*(OMNIROUTE_API_KEY|MATRIX_API_KEY|STORAGE_ENCRYPTION_KEY)/)
  })

  test("authenticates readiness and binds local service ports", () => {
    expect(launcher).toContain("http://127.0.0.1:20128/v1/models")
    expect(launcher).toContain("http://127.0.0.1:$matrix_api_port/v1/models")
    expect(launcher).toContain("OMNIROUTE_SERVER_HOST=127.0.0.1")
    expect(launcher).toContain("'omniroute-auth'")
    expect(launcher).toContain("'matrix-auth'")
    expect(launcher).toContain("port 20128 is occupied by a service that is not a ready OmniRoute")
  })

  test("owns only launched process groups and cleans them on exit or signals", () => {
    expect(launcher).toContain("trap cleanup EXIT")
    expect(launcher).toContain("trap 'exit 130' INT")
    expect(launcher).toContain("trap 'exit 143' TERM")
    expect(launcher).toContain('process_matches "$owned_pid" "$owned_marker"')
    expect(launcher).toContain('kill -TERM -- "-$owned_pid"')
    expect(launcher).toContain("OmniRoute already active and authenticated. Reusing it.")
  })

  test("uses only the bundled Matrix, Node, and OmniRoute executables", () => {
    expect(launcher).toContain('matrix_bin="$matrix_root/matrix"')
    expect(launcher).toContain('node_bin="$matrix_root/omniroute/node"')
    expect(launcher).toContain("omniroute/app/node_modules/omniroute/dist/server-ws.mjs")
    expect(launcher).not.toMatch(/command -v (node|npm|omniroute)/)
  })
})

describe("Linux Matrix provider template", () => {
  test("preserves free, reliable, and vision aliases", () => {
    expect(template).toContain('"id": "auto/coding:free"')
    expect(template).toContain('"id": "matrix-free-auto"')
    expect(template).toContain('"id": "matrix-coding-reliable"')
    expect(template).toContain('"id": "matrix-vision"')
    expect(template).toContain('"input": ["text", "image"]')
  })
})

describe("Linux source distribution hygiene", () => {
  test("contains no runtime state or private material", async () => {
    const files = await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: root, onlyFiles: true }))
    expect(files.some((file) => file.split(/[\\/]/).includes(".matrix"))).toBe(false)
    expect(files.some((file) => /(^|[\\/])\.env($|[.\\/])/.test(file))).toBe(false)
    expect(files.some((file) => /\.(db|sqlite|log)$/i.test(file))).toBe(false)
    expect(files.some((file) => /credential|auth\.json/i.test(file))).toBe(false)
  })
})
