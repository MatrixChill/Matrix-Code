import { createMemo, createSignal, onMount, Show } from "solid-js"
import { useSync } from "../context/sync"
import { map, pipe, sortBy } from "remeda"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useSDK } from "../context/sdk"
import { DialogPrompt } from "../ui/dialog-prompt"
import { Link } from "../ui/link"
import { useTheme } from "../context/theme"
import { TextAttributes } from "@opentui/core"
import type { ProviderAuthAuthorization, ProviderAuthMethod } from "@opencode-ai/sdk/v2"
import { DialogModel } from "./dialog-model"
import { useToast } from "../ui/toast"
import { isConsoleManagedProvider } from "../util/provider-origin"
import { useConnected } from "./use-connected"
import { useBindings } from "../keymap"
import { useClipboard } from "../context/clipboard"
import { t, tx } from "../i18n"

const PROVIDER_PRIORITY: Record<string, number> = {
  omniroute: 0,
  iflowcn: 1,
  alibaba: 2,
  "kimi-for-coding": 3,
  nvidia: 4,
  cerebras: 5,
  groq: 6,
  "cloudflare-workers-ai": 7,
  openrouter: 8,
  deepseek: 9,
  opencode: 10,
  "opencode-go": 11,
  openai: 12,
  "github-copilot": 13,
  anthropic: 14,
  google: 15,
}

const OMNIROUTE_PROVIDER_ID = "omniroute"
const OMNIROUTE_DEFAULT_URL = "http://localhost:20128/v1"
const CUSTOM_PROVIDER_OPTION_VALUE = "__opencode_custom_provider__"
const CUSTOM_PROVIDER_ID = /^[a-z0-9][a-z0-9-_]*$/

type ProviderOptionBase = {
  title: string
  value: string
  description?: string
  category: string
}

type ProviderOption =
  | (ProviderOptionBase & {
      type: "provider"
      providerID: string
    })
  | (ProviderOptionBase & {
      type: "custom"
    })

export function providerOptions(list: { id: string; name: string }[]): ProviderOption[] {
  const providers = list.some((provider) => provider.id === OMNIROUTE_PROVIDER_ID)
    ? list
    : [{ id: OMNIROUTE_PROVIDER_ID, name: "OmniRoute" }, ...list]
  return [
    ...pipe(
      providers,
      sortBy(
        (x) => PROVIDER_PRIORITY[x.id] ?? 99,
        (x) => x.name.toLowerCase(),
        (x) => x.id,
      ),
      map((provider) => ({
        type: "provider" as const,
        title: provider.name,
        value: provider.id,
        providerID: provider.id,
        description: (
          {
            omniroute: t("omniRouteRecommended"),
            iflowcn: t("externalFreeCodingProvider"),
            alibaba: t("externalFreeCodingProvider"),
            "kimi-for-coding": t("externalFreeCodingProvider"),
            nvidia: t("externalFreeTierProvider"),
            cerebras: t("externalFreeTierProvider"),
            groq: t("externalFreeTierProvider"),
            "cloudflare-workers-ai": t("externalFreeTierProvider"),
            openrouter: t("externalFreeTierProvider"),
            deepseek: t("externalProvider"),
            opencode: "(Recommended)",
            anthropic: "(API key)",
            openai: "(ChatGPT Plus/Pro or API key)",
            "opencode-go": "Low cost subscription for everyone",
          } satisfies Record<string, string>
        )[provider.id],
        category:
          provider.id === OMNIROUTE_PROVIDER_ID
            ? t("matrixFreeCoding")
            : provider.id in PROVIDER_PRIORITY
              ? t("recommendedFreeSetup")
              : t("categoryProviders"),
      })),
    ),
    {
      type: "custom",
      title: "Other",
      value: CUSTOM_PROVIDER_OPTION_VALUE,
      description: "Custom provider",
      category: "Providers",
    },
  ]
}

export function normalizeCustomProviderID(value: string) {
  const providerID = value.trim().replace(/^@ai-sdk\//, "")
  if (!CUSTOM_PROVIDER_ID.test(providerID)) return
  return providerID
}

export function createDialogProviderOptions() {
  const sync = useSync()
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  const { theme } = useTheme()
  const onboarded = useConnected()

  async function promptCustomProviderID(): Promise<string | undefined> {
    const value = await DialogPrompt.show(dialog, "Other", {
      placeholder: "Provider id",
      description: () => (
        <text fg={theme.textMuted}>
          This only stores a credential. Configure the provider in opencode.json to use it.
        </text>
      ),
    })
    if (value === null) return

    const providerID = normalizeCustomProviderID(value)
    if (providerID) return providerID

    toast.show({
      variant: "error",
      message:
        "Provider ids must start with a lowercase letter or number and only use lowercase letters, numbers, hyphens, and underscores",
    })
    return promptCustomProviderID()
  }

  const options = createMemo(() => {
    return pipe(
      providerOptions(sync.data.provider_next.all),
      map((provider) => {
        if (provider.type === "custom") {
          return {
            title: provider.title,
            value: provider.value,
            description: provider.description,
            category: provider.category,
            async onSelect() {
              const providerID = await promptCustomProviderID()
              if (!providerID) return
              return dialog.replace(() => <ApiMethod providerID={providerID} title="API key" custom />)
            },
          }
        }

        const providerID = provider.providerID
        const consoleManaged = isConsoleManagedProvider(sync.data.console_state.consoleManagedProviders, providerID)
        const connected = sync.data.provider_next.connected.includes(providerID)

        return {
          title: provider.title,
          value: provider.value,
          description: provider.description,
          footer: consoleManaged ? sync.data.console_state.activeOrgName : undefined,
          category: provider.category,
          gutter: connected && onboarded() ? () => <text fg={theme.success}>✓</text> : undefined,
          async onSelect() {
            if (providerID === OMNIROUTE_PROVIDER_ID) {
              return dialog.replace(() => <OmniRouteSetup />)
            }
            if (consoleManaged) return

            const methods = sync.data.provider_auth[providerID] ?? [
              {
                type: "api",
                label: "API key",
              },
            ]
            let index: number | null = 0
            if (methods.length > 1) {
              index = await new Promise<number | null>((resolve) => {
                dialog.replace(
                  () => (
                    <DialogSelect
                      title="Select auth method"
                      options={methods.map((x, index) => ({
                        title: x.label,
                        value: index,
                      }))}
                      onSelect={(option) => resolve(option.value)}
                    />
                  ),
                  () => resolve(null),
                )
              })
            }
            if (index == null) return
            const method = methods[index]
            if (method.type === "oauth") {
              let inputs: Record<string, string> | undefined
              if (method.prompts?.length) {
                const value = await PromptsMethod({
                  dialog,
                  prompts: method.prompts,
                })
                if (!value) return
                inputs = value
              }

              const result = await sdk.client.provider.oauth.authorize({
                providerID,
                method: index,
                inputs,
              })
              if (result.error) {
                toast.show({
                  variant: "error",
                  message: JSON.stringify(result.error),
                })
                dialog.clear()
                return
              }
              if (result.data?.method === "code") {
                dialog.replace(() => (
                  <CodeMethod providerID={providerID} title={method.label} index={index} authorization={result.data!} />
                ))
              }
              if (result.data?.method === "auto") {
                dialog.replace(() => (
                  <AutoMethod providerID={providerID} title={method.label} index={index} authorization={result.data!} />
                ))
              }
            }
            if (method.type === "api") {
              let metadata: Record<string, string> | undefined
              if (method.prompts?.length) {
                const value = await PromptsMethod({ dialog, prompts: method.prompts })
                if (!value) return
                metadata = value
              }
              return dialog.replace(() => (
                <ApiMethod providerID={providerID} title={method.label} metadata={metadata} />
              ))
            }
          },
        }
      }),
    )
  })
  return options
}

export function DialogProvider() {
  const options = createDialogProviderOptions()
  const connected = useConnected()
  return <DialogSelect title={connected() ? t("titleConnectProvider") : t("matrixAiSetup")} options={options()} />
}

function OmniRouteSetup() {
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const toast = useToast()
  const { theme } = useTheme()
  const configured = sync.data.config.provider?.[OMNIROUTE_PROVIDER_ID]?.options?.baseURL
  const [endpoint, setEndpoint] = createSignal(
    typeof configured === "string" ? configured : OMNIROUTE_DEFAULT_URL,
  )
  const [key, setKey] = createSignal("")

  async function run() {
    const endpointValue = await DialogPrompt.show(dialog, t("omniRouteEndpoint"), {
      value: endpoint(),
      placeholder: OMNIROUTE_DEFAULT_URL,
      description: () => (
        <box gap={1}>
          <text fg={theme.textMuted}>{t("omniRouteSetupDescription")}</text>
          <text fg={theme.textMuted}>{t("externalAuthorizationNotice")}</text>
        </box>
      ),
    })
    if (endpointValue === null) return

    const trimmed = endpointValue.trim().replace(/\/+$/, "")
    const parsed = URL.parse(trimmed)
    if (!parsed || !["http:", "https:"].includes(parsed.protocol)) {
      toast.show({ variant: "error", message: t("omniRouteInvalidEndpoint") })
      return run()
    }
    setEndpoint(trimmed)

    const keyValue = await DialogPrompt.show(dialog, t("omniRouteApiKey"), {
      value: key(),
      placeholder: t("omniRouteApiKeyOptional"),
      description: () => <text fg={theme.textMuted}>{t("omniRouteApiKeyDescription")}</text>,
    })
    if (keyValue === null) return
    setKey(keyValue)

    const reachable = await fetch(`${trimmed}/models`, {
      headers: keyValue.trim() ? { Authorization: `Bearer ${keyValue.trim()}` } : undefined,
      signal: AbortSignal.timeout(3500),
    })
      .then((response) => response.ok)
      .catch(() => false)

    if (!reachable) {
      const choice = await new Promise<"retry" | "back" | undefined>((resolve) => {
        dialog.replace(
          () => (
            <DialogSelect<"retry" | "back">
              title={t("omniRouteUnreachableTitle")}
              footer={<text fg={theme.textMuted}>{t("omniRouteUnreachableDescription")}</text>}
              options={[
                { title: t("omniRouteRetry"), value: "retry" },
                { title: t("chooseAnotherProvider"), value: "back" },
              ]}
              onSelect={({ value }) => resolve(value)}
            />
          ),
          () => resolve(undefined),
        )
      })
      if (choice === "retry") return run()
      if (choice === "back") return dialog.replace(() => <DialogProvider />)
      return
    }

    const result = await sdk.client.global.config.update({
      config: {
        model: `${OMNIROUTE_PROVIDER_ID}/matrix-free-coding`,
        provider: {
          [OMNIROUTE_PROVIDER_ID]: {
            name: "OmniRoute",
            npm: "@ai-sdk/openai-compatible",
            env: ["OMNIROUTE_API_KEY"],
            options: {
              ...sync.data.config.provider?.[OMNIROUTE_PROVIDER_ID]?.options,
              baseURL: trimmed,
            },
            models: {
              ...sync.data.config.provider?.[OMNIROUTE_PROVIDER_ID]?.models,
              "matrix-free-coding": {
                id: "auto/coding",
                name: "Matrix Free Coding — automatic fallback",
                reasoning: true,
                tool_call: true,
                limit: { context: 131072, output: 32768 },
              },
              "matrix-auto": {
                id: "auto",
                name: "Matrix Auto — balanced routing",
                reasoning: true,
                tool_call: true,
                limit: { context: 131072, output: 32768 },
              },
              "matrix-fast": {
                id: "auto/fast",
                name: "Matrix Fast — latency routing",
                reasoning: true,
                tool_call: true,
                limit: { context: 131072, output: 32768 },
              },
            },
          },
        },
      },
    })
    if (result.error) {
      toast.show({ variant: "error", message: t("omniRouteSetupFailed") })
      return
    }

    if (keyValue.trim()) {
      await sdk.client.auth.set({
        providerID: OMNIROUTE_PROVIDER_ID,
        auth: { type: "api", key: keyValue.trim() },
      })
    }

    await sdk.client.instance.dispose()
    await sync.bootstrap()
    toast.show({ variant: "success", message: t("omniRouteReady") })
    dialog.replace(() => <DialogModel providerID={OMNIROUTE_PROVIDER_ID} />)
  }

  onMount(run)
  return <></>
}

interface AutoMethodProps {
  index: number
  providerID: string
  title: string
  authorization: ProviderAuthAuthorization
}
function AutoMethod(props: AutoMethodProps) {
  const { theme } = useTheme()
  const sdk = useSDK()
  const dialog = useDialog()
  const sync = useSync()
  const toast = useToast()
  const clipboard = useClipboard()

  useBindings(() => ({
    bindings: [
      {
        key: "c",
        desc: "Copy provider code",
        group: "Dialog",
        cmd: () => {
          const code =
            props.authorization.instructions.match(/[A-Z0-9]{4}-[A-Z0-9]{4,5}/)?.[0] ?? props.authorization.url
          clipboard
            .write?.(code)
            .then(() => toast.show({ message: "Copied to clipboard", variant: "info" }))
            .catch(toast.error)
        },
      },
    ],
  }))

  onMount(async () => {
    const result = await sdk.client.provider.oauth.callback({
      providerID: props.providerID,
      method: props.index,
    })
    if (result.error) {
      toast.show({
        variant: "error",
        message:
          "name" in result.error && result.error.name === "ProviderAuthOauthCallbackFailed"
            ? "OAuth authorization failed. Try /connect again."
            : JSON.stringify(result.error),
      })
      dialog.clear()
      return
    }
    await sdk.client.instance.dispose()
    await sync.bootstrap()
    dialog.replace(() => <DialogModel providerID={props.providerID} />)
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {props.title}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <box gap={1}>
        <Link href={props.authorization.url} fg={theme.primary} />
        <text fg={theme.textMuted}>{props.authorization.instructions}</text>
      </box>
      <text fg={theme.textMuted}>{t("waitingAuthorization")}</text>
      <text fg={theme.text}>
        c <span style={{ fg: theme.textMuted }}>{t("copy")}</span>
      </text>
    </box>
  )
}

interface CodeMethodProps {
  index: number
  title: string
  providerID: string
  authorization: ProviderAuthAuthorization
}
function CodeMethod(props: CodeMethodProps) {
  const { theme } = useTheme()
  const sdk = useSDK()
  const sync = useSync()
  const dialog = useDialog()
  const [error, setError] = createSignal(false)

  return (
    <DialogPrompt
      title={props.title}
      placeholder={t("authorizationCode")}
      onConfirm={async (value) => {
        const { error } = await sdk.client.provider.oauth.callback({
          providerID: props.providerID,
          method: props.index,
          code: value,
        })
        if (!error) {
          await sdk.client.instance.dispose()
          await sync.bootstrap()
          dialog.replace(() => <DialogModel providerID={props.providerID} />)
          return
        }
        setError(true)
      }}
      description={() => (
        <box gap={1}>
          <text fg={theme.textMuted}>{props.authorization.instructions}</text>
          <Link href={props.authorization.url} fg={theme.primary} />
          <Show when={error()}>
            <text fg={theme.error}>{t("invalidCode")}</text>
          </Show>
        </box>
      )}
    />
  )
}

interface ApiMethodProps {
  providerID: string
  title: string
  metadata?: Record<string, string>
  custom?: boolean
}
function ApiMethod(props: ApiMethodProps) {
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const toast = useToast()
  const { theme } = useTheme()

  return (
    <DialogPrompt
      title={props.title}
      placeholder={t("apiKey")}
      description={() =>
        ({
          opencode: (
            <box gap={1}>
              <text fg={theme.textMuted}>
                Matrix Code gives you access to all the best coding models at the cheapest prices with a single API
                key.
              </text>
              <text fg={theme.text}>
                {tx("Go to")} <span style={{ fg: theme.primary }}>https://opencode.ai/zen</span> {tx("to get a key")}
              </text>
            </box>
          ),
          "opencode-go": (
            <box gap={1}>
              <text fg={theme.textMuted}>
                Matrix Code is a $10 per month subscription that provides reliable access to popular open coding models
                with generous usage limits.
              </text>
              <text fg={theme.text}>
                {tx("Go to")} <span style={{ fg: theme.primary }}>https://opencode.ai/go</span>{" "}
                {tx("and enable Matrix Code")}
              </text>
            </box>
          ),
        })[props.providerID] ?? undefined
      }
      onConfirm={async (value) => {
        if (!value) return
        await sdk.client.auth.set({
          providerID: props.providerID,
          auth: {
            type: "api",
            key: value,
            ...(props.metadata ? { metadata: props.metadata } : {}),
          },
        })
        await sdk.client.instance.dispose()
        await sync.bootstrap()
        if (props.custom && !sync.data.provider_next.all.some((provider) => provider.id === props.providerID)) {
          toast.show({
            variant: "info",
            message: t("savedCredential", { provider: props.providerID }),
          })
          dialog.clear()
          return
        }
        dialog.replace(() => <DialogModel providerID={props.providerID} />)
      }}
    />
  )
}

interface PromptsMethodProps {
  dialog: ReturnType<typeof useDialog>
  prompts: NonNullable<ProviderAuthMethod["prompts"]>[number][]
}
async function PromptsMethod(props: PromptsMethodProps) {
  const inputs: Record<string, string> = {}
  for (const prompt of props.prompts) {
    if (prompt.when) {
      const value = inputs[prompt.when.key]
      if (value === undefined) continue
      const matches = prompt.when.op === "eq" ? value === prompt.when.value : value !== prompt.when.value
      if (!matches) continue
    }

    if (prompt.type === "select") {
      const value = await new Promise<string | null>((resolve) => {
        props.dialog.replace(
          () => (
            <DialogSelect
              title={prompt.message}
              options={prompt.options.map((x) => ({
                title: x.label,
                value: x.value,
                description: x.hint,
              }))}
              onSelect={(option) => resolve(option.value)}
            />
          ),
          () => resolve(null),
        )
      })
      if (value === null) return null
      inputs[prompt.key] = value
      continue
    }

    const value = await new Promise<string | null>((resolve) => {
      props.dialog.replace(
        () => (
          <DialogPrompt title={prompt.message} placeholder={prompt.placeholder} onConfirm={(value) => resolve(value)} />
        ),
        () => resolve(null),
      )
    })
    if (value === null) return null
    inputs[prompt.key] = value
  }
  return inputs
}
