import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { useSync } from "../context/sync"
import { For, Show, createMemo } from "solid-js"
import { MatrixProfile } from "@opencode-ai/core/matrix/profile"
import { MatrixRouter } from "@opencode-ai/core/matrix/router"
import { buildRoutingStatus, type ProviderStatus } from "@opencode-ai/core/matrix/routing-status"

const STATUS_LABEL: Record<ProviderStatus, string> = {
  online: "ONLINE",
  offline: "OFFLINE",
  degraded: "DEGRADED",
  unknown: "UNKNOWN",
}

const STATUS_STYLE: Record<ProviderStatus, string> = {
  online: "pass",
  offline: "fail",
  degraded: "warn",
  unknown: "unknown",
}

export function DialogMatrixRouting() {
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

  const data = createMemo(() => {
    const router = MatrixRouter.make()
    return buildRoutingStatus(router, profile())
  })

  const onlineCount = createMemo(() => data().providers.filter((p) => p.status === "online").length)

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          /matrix-routing
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>

      <text fg={theme.text}>
        Profile: <b>{MatrixProfile.LABELS[profile()]}</b>
      </text>

      <box flexDirection="row" gap={1}>
        <text
          style={{
            fg: {
              pass: theme.success,
              warn: theme.warning,
              fail: theme.error,
              unknown: theme.textMuted,
            }[STATUS_STYLE[data().omniroute.status]] ?? theme.textMuted,
          }}
        >
          {STATUS_LABEL[data().omniroute.status]}
        </text>
        <text fg={theme.text}>
          <b>OmniRoute Gateway</b>
        </text>
        <text fg={theme.textMuted}>
          checked {data().omniroute.lastCheck.toLocaleTimeString()}
        </text>
      </box>

      <Show when={data().activeProvider}>
        <text fg={theme.text}>
          Active: <b>{data().activeProvider}</b>
        </text>
      </Show>
      <Show when={data().fallbackProvider}>
        <text fg={theme.text}>
          Fallback: <b>{data().fallbackProvider}</b>
        </text>
      </Show>

      <text fg={theme.textMuted}>
        {onlineCount()}/{data().providers.length} providers online
      </text>

      <For each={data().providers}>
        {(provider) => (
          <box flexDirection="row" gap={1}>
            <text
              flexShrink={0}
              style={{
                fg: {
                  pass: theme.success,
                  warn: theme.warning,
                  fail: theme.error,
                  unknown: theme.textMuted,
                }[STATUS_STYLE[provider.status]] ?? theme.textMuted,
              }}
            >
              {STATUS_LABEL[provider.status]}
            </text>
            <text fg={theme.text}>
              <b>{provider.name}</b>
            </text>
            <text fg={theme.textMuted}>
              {provider.availableModels} models
              <Show when={provider.vision}>
                <span> · vision</span>
              </Show>
            </text>
          </box>
        )}
      </For>

      <Show when={connectedProviderIDs().size === 0}>
        <text fg={theme.warning}>No providers connected.</text>
      </Show>
    </box>
  )
}
