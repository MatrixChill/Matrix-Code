import { createMemo, createSignal, For, Show } from "solid-js"
import { type ProviderStatus, type ProviderInfo, type RoutingStatusData, buildRoutingStatus } from "./routing-adapter"
import { MatrixRouter } from "@opencode-ai/core/matrix/router"

const STATUS_STYLES: Record<ProviderStatus, { dot: string; label: string }> = {
  online: { dot: "bg-icon-success-base", label: "Online" },
  offline: { dot: "bg-icon-critical-base", label: "Offline" },
  degraded: { dot: "bg-[var(--color-yellow-500)]", label: "Degraded" },
  unknown: { dot: "bg-border-weak-base", label: "Unknown" },
}

function StatusDot(props: { status: ProviderStatus; size?: "small" | "medium" }) {
  const sizeClass = props.size === "small" ? "size-1.5" : "size-2"
  return (
    <div
      class={`${sizeClass} rounded-full shrink-0 ${STATUS_STYLES[props.status].dot}`}
      aria-label={STATUS_STYLES[props.status].label}
    />
  )
}

function GatewayCard(props: { status: ProviderStatus; lastCheck: Date }) {
  const timeStr = createMemo(() => {
    return props.lastCheck.toLocaleTimeString()
  })

  return (
    <div class="flex items-center justify-between gap-4 rounded-lg border border-v2-border-border-base bg-v2-background-bg-layer-01 px-4 py-3">
      <div class="flex items-center gap-3">
        <div class="flex size-8 items-center justify-center rounded-md bg-v2-background-bg-layer-03">
          <span class="text-v2-text-text-base text-sm font-medium">OR</span>
        </div>
        <div class="flex flex-col">
          <span class="text-v2-text-text-base text-sm font-medium">OmniRoute</span>
          <span class="text-v2-text-text-muted text-xs">Gateway</span>
        </div>
      </div>
      <div class="flex items-center gap-3">
        <StatusDot status={props.status} />
        <span class="text-v2-text-text-muted text-xs">{STATUS_STYLES[props.status].label}</span>
        <span class="text-v2-text-text-faint text-xs">{timeStr()}</span>
      </div>
    </div>
  )
}

function ProviderRow(props: { provider: ProviderInfo; isActive: boolean; isFallback: boolean }) {
  return (
    <div class="flex items-center justify-between gap-4 rounded-md border border-v2-border-border-base bg-v2-background-bg-layer-01 px-4 py-2.5">
      <div class="flex items-center gap-3 min-w-0">
        <StatusDot status={props.provider.status} size="small" />
        <span class="text-v2-text-text-base text-sm truncate">{props.provider.name}</span>
        <Show when={props.isActive}>
          <span class="rounded bg-[var(--color-green-900)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-green-300)]">
            Active
          </span>
        </Show>
        <Show when={props.isFallback}>
          <span class="rounded bg-[var(--color-orange-900)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-orange-300)]">
            Fallback
          </span>
        </Show>
      </div>
      <div class="flex items-center gap-4 text-xs text-v2-text-text-muted">
        <span>{props.provider.availableModels} models</span>
        <Show when={props.provider.vision}>
          <span class="text-v2-text-text-faint">Vision</span>
        </Show>
      </div>
    </div>
  )
}

function SummaryBar(props: { data: RoutingStatusData }) {
  const online = createMemo(() => props.data.providers.filter((p) => p.status === "online").length)
  const total = createMemo(() => props.data.providers.length)

  return (
    <div class="flex items-center gap-4 text-xs text-v2-text-text-muted">
      <span>
        {online()}/{total()} providers online
      </span>
      <Show when={props.data.activeProvider}>
        <span>Active: {props.data.activeProvider}</span>
      </Show>
      <Show when={props.data.fallbackProvider}>
        <span>Fallback: {props.data.fallbackProvider}</span>
      </Show>
    </div>
  )
}

export function RoutingStatusView() {
  const [lastRefresh, setLastRefresh] = createSignal(new Date())
  const [router] = createSignal<MatrixRouter.Router | undefined>(undefined)

  const data = createMemo(() => {
    void lastRefresh()
    return buildRoutingStatus(router(), "smart")
  })

  const handleRefresh = () => {
    setLastRefresh(new Date())
  }

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--v2-background-bg-layer-01)_calc(100%_-_24px),transparent)]">
        <div class="flex items-center justify-between gap-4 pt-6 pb-6 max-w-[720px]">
          <h2 class="text-v2-text-text-base text-base font-medium">Routing / Providers</h2>
          <button
            type="button"
            class="rounded-md border border-v2-border-border-base bg-v2-background-bg-layer-01 px-3 py-1.5 text-xs text-v2-text-text-base hover:bg-v2-background-bg-layer-03 transition-colors"
            onClick={handleRefresh}
          >
            Refresh
          </button>
        </div>
      </div>

      <div class="flex flex-col gap-4 max-w-[720px]">
        <GatewayCard status={data().omniroute.status} lastCheck={data().omniroute.lastCheck} />

        <SummaryBar data={data()} />

        <div class="flex flex-col gap-1">
          <span class="text-v2-text-text-muted text-xs font-medium mb-1">Providers</span>
          <For each={data().providers}>
            {(provider) => (
              <ProviderRow
                provider={provider}
                isActive={provider.provider === data().activeProvider}
                isFallback={provider.provider === data().fallbackProvider}
              />
            )}
          </For>
        </div>
      </div>
    </div>
  )
}
