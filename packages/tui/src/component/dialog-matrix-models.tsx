import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { useSync } from "../context/sync"
import { For, Show, createMemo } from "solid-js"
import { MatrixProfile } from "@opencode-ai/core/matrix/profile"
import { MatrixCatalog } from "@opencode-ai/core/matrix/catalog"
import { MatrixRouter } from "@opencode-ai/core/matrix/router"

export type DialogMatrixModelsProps = {}

export function DialogMatrixModels() {
  const sync = useSync()
  const { theme } = useTheme()
  const dialog = useDialog()

  const matrix = createMemo(
    () => (sync.data.config as { matrix?: { profile?: string } } | undefined)?.matrix,
  )

  const profile = createMemo<MatrixProfile.ProfileID>(() => {
    const raw = matrix()?.profile
    return raw && MatrixProfile.isProfile(raw) ? raw : "reliable"
  })

  const connectedProviderIDs = createMemo(
    () => new Set(sync.data.provider.map((p) => p.id)),
  )

  const selection = createMemo(() => {
    const router = MatrixRouter.make()
    return router.select(profile(), MatrixCatalog.CATALOG, (candidate) =>
      connectedProviderIDs().has(candidate.provider),
    )
  })

  const candidates = createMemo(() => {
    const chosen = selection()?.candidate
    return MatrixCatalog.CATALOG.filter(
      (c) => (chosen === undefined || c.id !== chosen.id) && connectedProviderIDs().has(c.provider),
    ).slice(0, 4)
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          /matrix-models
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <text fg={theme.text}>
        Profile: <b>{MatrixProfile.LABELS[profile()]}</b>
      </text>
      <Show when={selection()} fallback={<text fg={theme.warning}>No candidate available for this profile.</text>}>
        {(sel) => (
          <>
            <box flexDirection="row" gap={1}>
              <text fg={theme.text}>
                Selected: <b>{sel().candidate.name}</b>
              </text>
              <text fg={theme.textMuted}>({sel().candidate.provider})</text>
              <text
                style={{
                  fg: sel().candidate.vision ? theme.success : theme.textMuted,
                }}
              >
                {sel().candidate.vision ? "Vision: yes" : "Vision: no"}
              </text>
            </box>
            <Show when={sel().candidate}>
              <text fg={theme.textMuted}>
                Rank: {sel().rank} · Health: {(sel().candidate as unknown as { health?: number }).health ?? 1}
              </text>
            </Show>
          </>
        )}
      </Show>
      <Show when={candidates().length > 0}>
        <text fg={theme.textMuted}>Fallback candidates:</text>
        <For each={candidates()}>
          {(c) => (
            <box flexDirection="row" gap={1}>
              <text fg={theme.text}>
                <span style={{ fg: theme.text }}>{c.name}</span>
              </text>
              <text fg={theme.textMuted}>
                ({c.provider}) vision={c.vision ? "yes" : "no"}
              </text>
            </box>
          )}
        </For>
      </Show>
    </box>
  )
}