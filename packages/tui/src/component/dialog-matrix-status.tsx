import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { useSync } from "../context/sync"
import { For, Show, createMemo } from "solid-js"

export type DialogMatrixStatusProps = {}

type Row = { label: string; state: "pass" | "warn" | "fail" | "unknown"; detail?: string }

export function DialogMatrixStatus() {
  const sync = useSync()
  const { theme } = useTheme()
  const dialog = useDialog()

  const rows = createMemo<Row[]>(() => {
    const config = sync.data.config
    const matrix = (config as { matrix?: { profile?: string } } | undefined)?.matrix
    const magicContext = (config as { plugin?: (string | [string, unknown])[] } | undefined)?.plugin?.some(
      (p) => (typeof p === "string" ? p : p[0]).toLowerCase().includes("magic-context"),
    )
    const gitHealthy = Boolean(sync.data.vcs)

    return [
      { label: "Core", state: "pass" },
      {
        label: "Magic Context",
        state: magicContext ? "pass" : "warn",
        detail: magicContext ? undefined : "plugin not loaded",
      },
      {
        label: "Agents",
        state: (sync.data.agent?.length ?? 0) > 0 ? "pass" : "warn",
        detail: `${sync.data.agent?.length ?? 0} configured`,
      },
      {
        label: "Commands",
        state: (sync.data.command?.length ?? 0) > 0 ? "pass" : "warn",
        detail: `${sync.data.command?.length ?? 0} available`,
      },
      {
        label: "Providers",
        state: (sync.data.provider?.length ?? 0) > 0 ? "pass" : "warn",
        detail: sync.data.provider?.map((p) => p.id).join(", "),
      },
      { label: "Git", state: gitHealthy ? "pass" : "warn", detail: gitHealthy ? "initialized" : "not initialized" },
      {
        label: "Matrix Profile",
        state: matrix?.profile ? "pass" : "warn",
        detail: matrix?.profile ?? "not configured (default)",
      },
    ]
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          /matrix-status
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <For each={rows()}>
        {(row) => (
          <box flexDirection="row" gap={1}>
            <text
              flexShrink={0}
              style={{
                fg: {
                  pass: theme.success,
                  warn: theme.warning,
                  fail: theme.error,
                  unknown: theme.textMuted,
                }[row.state] ?? theme.textMuted,
              }}
            >
              {row.state === "pass" ? "PASS" : row.state === "warn" ? "WARN" : row.state === "fail" ? "FAIL" : "UNKNOWN"}
            </text>
            <text fg={theme.text}>
              <b>{row.label}</b>
              <Show when={row.detail}>
                <span style={{ fg: theme.textMuted }}> {row.detail}</span>
              </Show>
            </text>
          </box>
        )}
      </For>
      <text fg={theme.textMuted}>Vision and Browser show up here once implemented.</text>
    </box>
  )
}