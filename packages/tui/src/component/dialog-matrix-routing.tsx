import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { useSync } from "../context/sync"
import { useSDK } from "../context/sdk"
import { For, Show, createMemo, createResource, onCleanup, onMount } from "solid-js"
import { MatrixProfile } from "@opencode-ai/core/matrix/profile"
import { MatrixRouter } from "@opencode-ai/core/matrix/router"
import { MatrixOmniRouteHealth } from "@opencode-ai/core/matrix/omniroute-health"
import {
  buildRoutingStatus,
  type ProviderStatus,
  type GatewayStatus,
} from "@opencode-ai/core/matrix/routing-status"

// Kept at module scope so failures recorded in the request path accumulate
// across dialog renders instead of starting from a fresh (always-healthy) router.
const liveRouter = MatrixRouter.make()

const PROVIDER_STATUS_LABEL: Record<ProviderStatus, string> = {
  online: "ONLINE",
  offline: "OFFLINE",
  degraded: "DEGRADED",
  unknown: "UNKNOWN",
}

const PROVIDER_STATUS_STYLE: Record<ProviderStatus, string> = {
  online: "pass",
  offline: "fail",
  degraded: "warn",
  unknown: "unknown",
}

const GATEWAY_STATUS_LABEL: Record<GatewayStatus, string> = {
  online: "ONLINE",
  offline: "OFFLINE",
  unknown: "UNKNOWN",
}

const GATEWAY_STATUS_STYLE: Record<GatewayStatus, string> = {
  online: "pass",
  offline: "fail",
  unknown: "unknown",
}

export function DialogMatrixRouting() {
  const sync = useSync()
  const sdk = useSDK()
  const { theme } = useTheme()
  const dialog = useDialog()

  const matrix = createMemo(
    () => (sync.data.config as { matrix?: { profile?: string } } | undefined)?.matrix,
  )

  const profile = createMemo<MatrixProfile.ProfileID>(() => {
    const raw = matrix()?.profile
    return raw && MatrixProfile.isProfile(raw) ? raw : "reliable"
  })

  const gatewayURL = createMemo(() => {
    const baseURL = (
      sync.data.config as { provider?: { omniroute?: { options?: { baseURL?: string } } } } | undefined
    )?.provider?.omniroute?.options?.baseURL
    return typeof baseURL === "string" && baseURL.trim() ? baseURL : undefined
  })

  const [gatewayProbe] = createResource(gatewayURL, (url) => MatrixOmniRouteHealth.probe(url))

  const connectedProviderIDs = createMemo(
    () => new Set(sync.data.provider.map((p) => p.id)),
  )

  const data = createMemo(() => buildRoutingStatus(liveRouter, profile(), gatewayProbe()))

  // Mirror the server-side router state (recorded from real request failures)
  // into the live router so this dialog surfaces what the process actually saw.
  const refreshRouting = async () => {
    try {
      const result = await sdk.client.matrix.routing()
      const snapshot = result.data
      if (!snapshot) return
      const states = new Map<string, MatrixRouter.CandidateState>()
      for (const candidate of snapshot.candidates) {
        const lastError = candidate.lastError
        states.set(candidate.id, {
          health: Number(candidate.health),
          cooldownUntil: Number(candidate.cooldownUntil),
          recentFailures: Number(candidate.recentFailures),
          ...(lastError === undefined || lastError === null
            ? {}
            : {
                lastError: {
                  message: lastError.message,
                  at: Number(lastError.at),
                  ...(lastError.code === undefined ? {} : { code: lastError.code }),
                  ...(lastError.status === undefined ? {} : { status: Number(lastError.status) }),
                },
              }),
        })
      }
      liveRouter.restore(states)
    } catch {
      // Older or remote server without the /matrix/routing route: keep the
      // local router state collected so far.
    }
  }

  onMount(() => {
    void refreshRouting()
    const timer = setInterval(refreshRouting, 5000)
    onCleanup(() => clearInterval(timer))
  })

  const onlineCount = createMemo(() => data().providers.filter((p) => p.status === "online").length)

  const gatewayDetail = createMemo(() => {
    const gateway = data().gateway
    const parts: string[] = []
    if (gateway.statusCode !== undefined) {
      parts.push(`HTTP ${gateway.statusCode}`)
    } else if (gateway.error !== undefined) {
      parts.push(gateway.error)
    }
    parts.push(`checked ${gateway.lastChecked.toLocaleTimeString()}`)
    return parts.join(" · ")
  })

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
            }[GATEWAY_STATUS_STYLE[data().gateway.status]] ?? theme.textMuted,
          }}
        >
          {GATEWAY_STATUS_LABEL[data().gateway.status]}
        </text>
        <text fg={theme.text}>
          <b>OmniRoute Gateway</b>
        </text>
        <text fg={theme.textMuted}>{gatewayDetail()}</text>
      </box>

      <box flexDirection="row" gap={1}>
        <text
          style={{
            fg: {
              pass: theme.success,
              warn: theme.warning,
              fail: theme.error,
              unknown: theme.textMuted,
            }[PROVIDER_STATUS_STYLE[data().routingStatus]] ?? theme.textMuted,
          }}
        >
          {PROVIDER_STATUS_LABEL[data().routingStatus]}
        </text>
        <text fg={theme.text}>
          <b>Routing layer</b>
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

      <Show when={data().lastError}>
        {(lastError) => (
          <text fg={theme.error}>
            Last error: <b>{formatProviderError(lastError())}</b>
          </text>
        )}
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
                }[PROVIDER_STATUS_STYLE[provider.status]] ?? theme.textMuted,
              }}
            >
              {PROVIDER_STATUS_LABEL[provider.status]}
            </text>
            <text fg={theme.text}>
              <b>{provider.name}</b>
            </text>
            <text fg={theme.textMuted}>
              {provider.availableModels} models
              <Show when={provider.vision}>
                <span> · vision</span>
              </Show>
              <Show when={provider.health !== null}>
                <span> · health {provider.health!.toFixed(2)}</span>
              </Show>
              <Show when={provider.lastError}>
                <span style={{ fg: theme.error }}>
                  {" "}
                  · {provider.lastError!.status !== undefined ? `HTTP ${provider.lastError!.status}` : provider.lastError!.message}
                </span>
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

function formatProviderError(error: { message: string; code?: string; status?: number; at: Date }) {
  const detail =
    error.status !== undefined ? `HTTP ${error.status}` : error.code !== undefined ? error.code : error.message
  return `${detail} · ${error.at.toLocaleTimeString()}`
}