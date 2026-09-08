import { TextareaRenderable, TextAttributes, type PasteEvent } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useDialog, type DialogContext } from "./dialog"
import { Show, createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { Spinner } from "../component/spinner"
import { useTuiConfig } from "../config"
import { useBindings, useCommandShortcut, useOpencodeKeymap } from "../keymap"
import { t, tx } from "../i18n"
import { useClipboard } from "../context/clipboard"
import { useRenderer } from "@opentui/solid"
import { PasteFlow, pasteBytesToText } from "../paste-flow"

/** Mask character used for secret input fields. */
export const SECRET_MASK = "•"

function sanitizeSecret(text: string) {
  return text.replace(/[\r\n]+/g, "").trim()
}

export type DialogPromptProps = {
  title: string
  description?: () => import("solid-js").JSX.Element
  placeholder?: string
  value?: string
  busy?: boolean
  busyText?: string
  /** When set, the input is masked and the real value stays in memory only. */
  secret?: boolean
  onConfirm?: (value: string) => void
  onCancel?: () => void
}

export function DialogPrompt(props: DialogPromptProps) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const submitShortcut = useCommandShortcut("dialog.prompt.submit")
  const keymap = useOpencodeKeymap()
  const renderer = useRenderer()
  const clipboard = useClipboard()
  const isSecret = () => props.secret === true
  const [textareaTarget, setTextareaTarget] = createSignal<TextareaRenderable>()
  const [secretValue, setSecretValue] = createSignal(props.value ?? "")
  const pasteFlow = new PasteFlow()
  let textarea: TextareaRenderable

  function secretActive() {
    return isSecret() && !props.busy && textareaTarget() !== undefined
  }

  function setMask() {
    if (!textarea || textarea.isDestroyed) return
    const mask = isSecret() ? SECRET_MASK.repeat(secretValue().length) : ""
    textarea.editBuffer.setText(mask)
    textarea.gotoLineEnd()
  }

  function setSecret(next: string) {
    setSecretValue(next)
    setMask()
  }

  async function pasteSecretFromClipboard() {
    if (!secretActive() || pasteFlow.shouldSkipCommand()) return
    pasteFlow.begin()
    try {
      const content = await clipboard.read?.()
      if (content?.mime === "text/plain" && content.data) {
        setSecret(secretValue() + sanitizeSecret(content.data))
        pasteFlow.markInserted()
      }
    } finally {
      pasteFlow.end()
    }
  }

  function confirm() {
    if (props.busy) return
    props.onConfirm?.(isSecret() ? secretValue() : textarea.plainText)
  }

  useBindings(() => ({
    target: textareaTarget,
    enabled: textareaTarget() !== undefined && !props.busy,
    // Dialog form semantics must win over the global managed textarea input layer.
    priority: 1,
    commands: [
      {
        name: "dialog.prompt.submit",
        title: t("submitDialogPrompt"),
        category: t("categoryDialog"),
        run: confirm,
      },
    ],
    bindings: tuiConfig.keybinds.gather("dialog.prompt", ["dialog.prompt.submit"]),
  }))

  onMount(() => {
    dialog.setSize("medium")
    if (isSecret()) {
      setMask()
      const offKey = keymap.intercept(
        "key",
        (ctx) => {
          const event = ctx.event
          if (!secretActive()) return
          // Dialog bindings own these (submit / cancel / interrupt).
          if (event.name === "return" || event.name === "escape" || (event.ctrl && event.name === "c")) return
          event.preventDefault()
          event.stopPropagation()
          if (event.ctrl && event.name === "v") {
            void pasteSecretFromClipboard()
            return
          }
          if (event.shift && event.name === "insert") {
            void pasteSecretFromClipboard()
            return
          }
          if (event.ctrl && event.name === "u") {
            setSecret("")
            return
          }
          if (event.name === "backspace") {
            setSecret(secretValue().slice(0, -1))
            return
          }
          if (!event.ctrl && !event.meta && !event.option && (event.name.length === 1 || event.name === "space")) {
            setSecret(secretValue() + event.sequence)
            return
          }
          // Any other modified/control key is swallowed for full input isolation.
        },
        { priority: 1 },
      )

      const onPasteEvent = (event: PasteEvent) => {
        if (!secretActive()) return
        const text = pasteBytesToText(event.bytes)
        if (!text) return
        event.preventDefault()
        if (pasteFlow.shouldSkipBytes()) return
        pasteFlow.begin()
        setSecret(secretValue() + sanitizeSecret(text))
        pasteFlow.markInserted()
        pasteFlow.end()
      }
      renderer.keyInput.prependListener("paste", onPasteEvent as never)
      onCleanup(() => {
        offKey?.()
        renderer.keyInput.off("paste", onPasteEvent as never)
      })
    }
    setTimeout(() => {
      if (!textarea || textarea.isDestroyed) return
      if (props.busy) return
      textarea.focus()
    }, 1)
    textarea.gotoLineEnd()
  })

  createEffect(() => {
    if (!textarea || textarea.isDestroyed) return
    const traits = props.busy
      ? {
          suspend: true,
          status: "BUSY",
        }
      : {}
    textarea.traits = traits
    if (props.busy) {
      textarea.blur()
      return
    }
    textarea.focus()
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {tx(props.title)}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <box gap={1}>
        {props.description?.()}
        <textarea
          height={3}
          ref={(val: TextareaRenderable) => {
            textarea = val
            setTextareaTarget(val)
          }}
          initialValue={isSecret() ? "" : props.value}
          placeholder={tx(props.placeholder) ?? t("enterText")}
          placeholderColor={theme.textMuted}
          textColor={props.busy ? theme.textMuted : theme.text}
          focusedTextColor={props.busy ? theme.textMuted : theme.text}
          cursorColor={props.busy ? theme.backgroundElement : theme.text}
          cursorStyle={tuiConfig.cursor}
        />
        <Show when={props.busy}>
          <Spinner color={theme.textMuted}>{tx(props.busyText) ?? t("working")}</Spinner>
        </Show>
      </box>
      <box paddingBottom={1} gap={1} flexDirection="row">
        <Show when={!props.busy} fallback={<text fg={theme.textMuted}>{t("processing")}</text>}>
          <Show when={submitShortcut()}>
            <text fg={theme.text}>
              {submitShortcut()} <span style={{ fg: theme.textMuted }}>{t("submit")}</span>
            </text>
          </Show>
        </Show>
      </box>
    </box>
  )
}

DialogPrompt.show = (dialog: DialogContext, title: string, options?: Omit<DialogPromptProps, "title">) => {
  return new Promise<string | null>((resolve) => {
    dialog.replace(
      () => (
        <DialogPrompt title={title} {...options} onConfirm={(value) => resolve(value)} onCancel={() => resolve(null)} />
      ),
      () => resolve(null),
    )
  })
}
