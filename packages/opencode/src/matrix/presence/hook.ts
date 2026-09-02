import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config, latest } from "@opencode-ai/core/config"
import { Context, Effect, Layer } from "effect"
import { MatrixPresence, type PresenceConfig, type PresenceStatus } from "./presence"

export interface Interface {
  readonly update: (status: PresenceStatus) => void
  readonly dispose: () => void
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MatrixPresenceHook") {}

/** Map the canonical V2 session status to a Discord presence mode. */
function mapStatus(type: string): PresenceStatus["mode"] {
  switch (type) {
    case "idle":
      return "IDLE"
    case "retry":
      return "THINKING"
    case "busy":
      return "CODING"
    default:
      return "CODING"
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const events = yield* EventV2Bridge.Service

    const entries = yield* config.entries()
    const matrix = latest(entries, "matrix")
    const d = matrix?.discordPresence ?? {}
    const presenceConfig: PresenceConfig = {
      enabled: d.enabled === true,
      showProjectName: d.showProjectName === true,
      showModelProfile: d.showModelProfile !== false,
      showElapsedTime: d.showElapsedTime !== false,
      showRepositoryButton: d.showRepositoryButton === true,
    }

    if (!presenceConfig.enabled) {
      return Service.of({ update: () => {}, dispose: () => {} })
    }

    const presence = new MatrixPresence(presenceConfig)
    const startedAt = Date.now()

    yield* events.listen((event) =>
      Effect.gen(function* () {
        if (event.id === "session.idle") {
          presence.update({ mode: "IDLE", startedAt: startedAt / 1000 })
          return
        }
        if (event.id !== "session.status") return
        const payload = event.data as { status?: { type?: string } }
        const type = payload.status?.type
        if (!type) return
        presence.update({ mode: mapStatus(type), startedAt: startedAt / 1000 })
      }),
    )

    return Service.of({
      update: (status) => presence.update(status),
      dispose: () => presence.dispose(),
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [Config.node, EventV2Bridge.node] })

export * as MatrixPresenceHook from "./hook"
