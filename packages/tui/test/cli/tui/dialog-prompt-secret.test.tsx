/** @jsxImportSource @opentui/solid */
import { TextareaRenderable } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup } from "solid-js"
import { tmpdir } from "../../fixture/fixture"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import type { TuiKeybind } from "../../../src/config/keybind"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { ClipboardProvider, type ClipboardService } from "../../../src/context/clipboard"

const MASK = "•"

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

async function mountSecretPrompt(input: {
  root: string
  keybinds: Partial<TuiKeybind.Keybinds>
  onConfirm: (value: string | null) => void
  clipboard?: ClipboardService
}) {
  const state = path.join(input.root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  const [
    { DialogProvider },
    { DialogPrompt },
    { KVProvider },
    { ThemeProvider },
    { TuiConfigProvider },
    { ToastProvider },
    { OpencodeKeymapProvider, registerOpencodeKeymap },
  ] = await Promise.all([
    import("../../../src/ui/dialog"),
    import("../../../src/ui/dialog-prompt"),
    import("../../../src/context/kv"),
    import("../../../src/context/theme"),
    import("../../../src/config"),
    import("../../../src/ui/toast"),
    import("../../../src/keymap"),
  ])

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const resolvedConfig = createTuiResolvedConfig({
      keybinds: input.keybinds,
      leader_timeout: 1000,
    })
    const off = registerOpencodeKeymap(keymap, renderer, resolvedConfig)
    onCleanup(off)

    return (
      <TestTuiContexts
        directory={input.root}
        paths={{
          home: input.root,
          state,
          worktree: input.root,
        }}
      >
        <ClipboardProvider value={input.clipboard}>
          <OpencodeKeymapProvider keymap={keymap}>
            <TuiConfigProvider config={resolvedConfig}>
              <KVProvider>
                <ThemeProvider mode="dark">
                  <ToastProvider>
                    <DialogProvider>
                      <DialogPrompt title="OmniRoute API key" secret onConfirm={input.onConfirm} />
                    </DialogProvider>
                  </ToastProvider>
                </ThemeProvider>
              </KVProvider>
            </TuiConfigProvider>
          </OpencodeKeymapProvider>
        </ClipboardProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { kittyKeyboard: true })
  return {
    app,
    async cleanup() {
      app.renderer.destroy()
    },
  }
}

test("typing a secret stays masked and confirms the real value", async () => {
  await using tmp = await tmpdir()
  const confirmed: (string | null)[] = []
  const prompt = await mountSecretPrompt({
    root: tmp.path,
    keybinds: {},
    onConfirm: (value) => confirmed.push(value),
  })

  try {
    await wait(() => prompt.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    const textarea = prompt.app.renderer.currentFocusedEditor
    if (!(textarea instanceof TextareaRenderable)) throw new Error("expected focused dialog textarea")

    prompt.app.mockInput.typeText("matrix-key-123")

    expect(textarea.plainText).toBe(MASK.repeat(14))
    expect(textarea.plainText).not.toContain("matrix-key-123")
    expect(confirmed).toEqual([])

    prompt.app.mockInput.pressEnter()
    expect(confirmed).toEqual(["matrix-key-123"])
  } finally {
    await prompt.cleanup()
  }
})

test("backspace and ctrl+u edit the masked secret without leaking", async () => {
  await using tmp = await tmpdir()
  const confirmed: (string | null)[] = []
  const prompt = await mountSecretPrompt({
    root: tmp.path,
    keybinds: {},
    onConfirm: (value) => confirmed.push(value),
  })

  try {
    await wait(() => prompt.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    const textarea = prompt.app.renderer.currentFocusedEditor
    if (!(textarea instanceof TextareaRenderable)) throw new Error("expected focused dialog textarea")

    prompt.app.mockInput.typeText("abc")
    expect(textarea.plainText).toBe(MASK.repeat(3))

    prompt.app.mockInput.pressBackspace()
    expect(textarea.plainText).toBe(MASK.repeat(2))

    prompt.app.mockInput.pressKey("u", { ctrl: true })
    expect(textarea.plainText).toBe("")

    prompt.app.mockInput.typeText("final")
    prompt.app.mockInput.pressEnter()
    expect(confirmed).toEqual(["final"])
  } finally {
    await prompt.cleanup()
  }
})

test("bracketed paste into the secret copies the bytes masked", async () => {
  await using tmp = await tmpdir()
  const confirmed: (string | null)[] = []
  const prompt = await mountSecretPrompt({
    root: tmp.path,
    keybinds: {},
    onConfirm: (value) => confirmed.push(value),
  })

  try {
    await wait(() => prompt.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    const textarea = prompt.app.renderer.currentFocusedEditor
    if (!(textarea instanceof TextareaRenderable)) throw new Error("expected focused dialog textarea")

    prompt.app.mockInput.pasteBracketedText("sk-super-secret")

    expect(textarea.plainText).toBe(MASK.repeat(15))
    expect(textarea.plainText).not.toContain("sk-super-secret")

    prompt.app.mockInput.pressEnter()
    expect(confirmed).toEqual(["sk-super-secret"])
  } finally {
    await prompt.cleanup()
  }
})

test("ctrl+v falls back to clipboard when no paste bytes arrive", async () => {
  await using tmp = await tmpdir()
  const confirmed: (string | null)[] = []
  const prompt = await mountSecretPrompt({
    root: tmp.path,
    keybinds: {},
    clipboard: {
      read: async () => ({ data: "sk-from-clipboard", mime: "text/plain" }),
      write: async () => {},
    },
    onConfirm: (value) => confirmed.push(value),
  })

  try {
    await wait(() => prompt.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    const textarea = prompt.app.renderer.currentFocusedEditor
    if (!(textarea instanceof TextareaRenderable)) throw new Error("expected focused dialog textarea")

    prompt.app.mockInput.pressKey("v", { ctrl: true })
    await wait(() => textarea.plainText.length > 0)

    expect(textarea.plainText).toBe(MASK.repeat(17))

    prompt.app.mockInput.pressEnter()
    expect(confirmed).toEqual(["sk-from-clipboard"])
  } finally {
    await prompt.cleanup()
  }
})

test("modified keys are swallowed without leaking into the mask", async () => {
  await using tmp = await tmpdir()
  const confirmed: (string | null)[] = []
  const prompt = await mountSecretPrompt({
    root: tmp.path,
    keybinds: {},
    clipboard: {
      read: async () => ({ data: "sk-shift-insert", mime: "text/plain" }),
      write: async () => {},
    },
    onConfirm: (value) => confirmed.push(value),
  })

  try {
    await wait(() => prompt.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    const textarea = prompt.app.renderer.currentFocusedEditor
    if (!(textarea instanceof TextareaRenderable)) throw new Error("expected focused dialog textarea")

    // The mock keymap cannot synthesize an Insert key; the shift+insert branch
    // shares the exact clipboard fallback path already covered by ctrl+v. Here
    // we assert isolation: an unrelated modified key neither inserts into the
    // buffer nor reaches the focused renderable.
    prompt.app.mockInput.typeText("m")
    prompt.app.mockInput.pressKey("x", { ctrl: true })
    expect(textarea.plainText).toBe(MASK.repeat(1))

    prompt.app.mockInput.pressEnter()
    expect(confirmed).toEqual(["m"])
  } finally {
    await prompt.cleanup()
  }
})

test("escape and ctrl+c cancel without confirming and without copying", async () => {
  await using tmp = await tmpdir()
  const confirmed: (string | null)[] = []
  let copies = 0
  const prompt = await mountSecretPrompt({
    root: tmp.path,
    keybinds: {},
    clipboard: {
      read: async () => ({ data: "sk-x", mime: "text/plain" }),
      write: async () => {
        copies++
      },
    },
    onConfirm: (value) => confirmed.push(value),
  })

  try {
    await wait(() => prompt.app.renderer.currentFocusedEditor instanceof TextareaRenderable)

    prompt.app.mockInput.typeText("sk-visible")
    prompt.app.mockInput.pressEscape()
    expect(confirmed).toEqual([])
    expect(copies).toBe(0)

    prompt.app.mockInput.typeText("sk-again")
    prompt.app.mockInput.pressCtrlC()
    expect(confirmed).toEqual([])
    expect(copies).toBe(0)
  } finally {
    await prompt.cleanup()
  }
})

test("bytes during an in-flight clipboard read are not double-inserted", async () => {
  await using tmp = await tmpdir()
  const confirmed: (string | null)[] = []
  let resolveRead: ((value: { data: string; mime: string }) => void) | undefined
  const prompt = await mountSecretPrompt({
    root: tmp.path,
    keybinds: {},
    clipboard: {
      read: () =>
        new Promise((resolve) => {
          resolveRead = resolve
        }),
      write: async () => {},
    },
    onConfirm: (value) => confirmed.push(value),
  })

  try {
    await wait(() => prompt.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    const textarea = prompt.app.renderer.currentFocusedEditor
    if (!(textarea instanceof TextareaRenderable)) throw new Error("expected focused dialog textarea")

    prompt.app.mockInput.pressKey("v", { ctrl: true })
    prompt.app.mockInput.pasteBracketedText("BBBB")
    await wait(() => resolveRead !== undefined)
    resolveRead?.({ data: "CCCC", mime: "text/plain" })
    await wait(() => textarea.plainText.length > 0)

    expect(textarea.plainText).toBe(MASK.repeat(4))

    prompt.app.mockInput.pressEnter()
    expect(confirmed).toEqual(["CCCC"])
  } finally {
    await prompt.cleanup()
  }
})

test("a command paste right after bytes does not double-insert", async () => {
  await using tmp = await tmpdir()
  const confirmed: (string | null)[] = []
  const prompt = await mountSecretPrompt({
    root: tmp.path,
    keybinds: {},
    clipboard: {
      read: async () => ({ data: "DDDD", mime: "text/plain" }),
      write: async () => {},
    },
    onConfirm: (value) => confirmed.push(value),
  })

  try {
    await wait(() => prompt.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    const textarea = prompt.app.renderer.currentFocusedEditor
    if (!(textarea instanceof TextareaRenderable)) throw new Error("expected focused dialog textarea")

    prompt.app.mockInput.pasteBracketedText("AAAA")
    prompt.app.mockInput.pressKey("v", { ctrl: true })
    await wait(() => textarea.plainText.length > 0)

    expect(textarea.plainText).toBe(MASK.repeat(4))

    prompt.app.mockInput.pressEnter()
    expect(confirmed).toEqual(["AAAA"])
  } finally {
    await prompt.cleanup()
  }
})