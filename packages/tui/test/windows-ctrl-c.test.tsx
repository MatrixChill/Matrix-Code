/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onCleanup } from "solid-js"
import { OPENCODE_BASE_MODE } from "../src/keymap"

// Regression test for the Windows Ctrl+C blocker:
// packages/tui/src/component/prompt/index.tsx installs a Ctrl+C key intercept.
//
// The reported bug: the global `app.exit` layer enables `ctrl+c` when the prompt
// input is empty and focused. Pressing Ctrl+C to interrupt a running task then
// fired `app.exit`, which destroys the renderer and resets the terminal font and
// format.
//
// The fix: a key intercept at priority 0 (below the copy-on-select intercept at
// priority 1, but always before layer dispatch) claims Ctrl+C when the input is
// empty, focused and there is no selection. It consumes the event (so `app.exit`
// can never run) and dispatches `session.interrupt` when a session is active.
//
// This harness mirrors the exact intercept logic and the `app.exit` layer shape
// so the invariant is locked in with the real @opentui/keymap: an intercept
// always runs before layer dispatch, and `consume()` prevents the layer from
// receiving the event.

function createCtrlCHarness(opts: {
  inputText: string
  focused: boolean
  selection: boolean
  sessionActive: boolean
}) {
  let exits = 0
  let interrupts = 0

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)

    // Mirrors the global `app_exit` layer in app.tsx: active when the prompt
    // input is not focused, or focused with an empty input. The raw keymap has
    // no `enabled` field (that is the opencode adapter's compiler), so for this
    // static harness we only register the layer when its `enabled` guard would
    // hold.
    const offExit = !opts.focused || opts.inputText === ""
      ? keymap.registerLayer({
          mode: OPENCODE_BASE_MODE,
          commands: [{ name: "app.exit", run: () => { exits += 1 } }],          bindings: [{ key: "ctrl+c", cmd: "app.exit" }],
        })
      : () => {}

    // The `session.interrupt` command fired by the production intercept.
    const offInterrupt = keymap.registerLayer({
      mode: OPENCODE_BASE_MODE,
      commands: [{ name: "session.interrupt", run: () => { interrupts += 1 } }],
    })

    // Mirrors the copy-on-select intercept (app.tsx, priority 1): only consumes
    // Ctrl+C when there is an internal selection, otherwise leaves it alone.
    const offSelection = keymap.intercept(
      "key",
      (ctx) => {
        if (!opts.selection) return
        const evt = ctx.event
        if (evt.ctrl && evt.name === "c") ctx.consume()
      },
      { priority: 1 },
    )

    // Mirrors the production Ctrl+C intercept (prompt/index.tsx, priority 0).
    const offIntercept = keymap.intercept(
      "key",
      (ctx) => {
        const evt = ctx.event
        if (!evt.ctrl || evt.name !== "c") return
        if (!opts.focused) return
        if (opts.inputText !== "") return
        ctx.consume({ preventDefault: true, stopPropagation: true })
        if (opts.sessionActive) keymap.dispatchCommand("session.interrupt")
      },
      { priority: 0 },
    )

    onCleanup(() => {
      offSelection()
      offIntercept()
      offInterrupt()
      offExit()
    })

    return <box />
  }

  return { Harness, read: () => ({ exits, interrupts }) }
}

async function withHarness(opts: { inputText: string; focused: boolean; selection: boolean; sessionActive: boolean }) {
  const harness = createCtrlCHarness(opts)
  const { Harness } = harness
  const app = await testRender(() => <Harness />)
  return { ...harness, app }
}

test("ctrl+c with empty focused input and no selection interrupts, never exits", async () => {
  const h = await withHarness({ inputText: "", focused: true, selection: false, sessionActive: true })
  try {
    h.app.mockInput.pressCtrlC()
    expect(h.read()).toEqual({ exits: 0, interrupts: 1 })
  } finally {
    h.app.renderer.destroy()
  }
})

test("ctrl+c with empty focused input and an idle session consumes without exiting", async () => {
  const h = await withHarness({ inputText: "", focused: true, selection: false, sessionActive: false })
  try {
    h.app.mockInput.pressCtrlC()
    expect(h.read()).toEqual({ exits: 0, interrupts: 0 })
  } finally {
    h.app.renderer.destroy()
  }
})

test("ctrl+c with a selection is claimed by the selection intercept, not the exit", async () => {
  const h = await withHarness({ inputText: "", focused: true, selection: true, sessionActive: true })
  try {
    h.app.mockInput.pressCtrlC()
    // The selection intercept (priority 1) consumes the event before both the
    // production intercept (priority 0) and the app_exit layer.
    expect(h.read()).toEqual({ exits: 0, interrupts: 0 })
  } finally {
    h.app.renderer.destroy()
  }
})

test("ctrl+c with text in the input does not exit (prompt.clear owns it)", async () => {
  const h = await withHarness({ inputText: "hello", focused: true, selection: false, sessionActive: true })
  try {
    h.app.mockInput.pressCtrlC()
    // Non-empty input leaves the production intercept inert and disables
    // app_exit, so nothing runs here (the real prompt.clear binding owns it).
    expect(h.read()).toEqual({ exits: 0, interrupts: 0 })
  } finally {
    h.app.renderer.destroy()
  }
})
