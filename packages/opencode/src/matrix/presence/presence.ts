import {
  DiscordPresenceClient,
  type DiscordPresenceOptions,
  type PresenceStatus,
} from "./discord-ipc"
export type { PresenceStatus } from "./discord-ipc"

export interface PresenceConfig {
  enabled: boolean
  showProjectName: boolean
  showModelProfile: boolean
  showElapsedTime: boolean
  showRepositoryButton: boolean
}

export const defaultPresenceConfig: PresenceConfig = {
  enabled: false,
  showProjectName: false,
  showModelProfile: true,
  showElapsedTime: true,
  showRepositoryButton: false,
}

/**
 * Wrapper over the Discord RPC client. Constructing it with Discord disabled
 * is a no-op, and every update fails silently if Discord is not reachable, so
 * presence never affects Matrix Code when disabled or offline.
 */
export class MatrixPresence {
  private client: DiscordPresenceClient | null = null

  constructor(config: PresenceConfig) {
    if (!config.enabled) return
    const options: DiscordPresenceOptions = {
      clientID: "matrix-code",
      showProjectName: config.showProjectName,
      showModelProfile: config.showModelProfile,
      showElapsedTime: config.showElapsedTime,
      showRepositoryButton: config.showRepositoryButton,
    }
    this.client = new DiscordPresenceClient(options)
    this.client.connect()
  }

  update(status: PresenceStatus): void {
    this.client?.setStatus(status)
  }

  dispose(): void {
    this.client?.close()
    this.client = null
  }
}

export * as MatrixPresencePresence from "./presence"
