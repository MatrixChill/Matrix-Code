// Minimal Discord Rich Presence IPC client, isolated and dependency-free.
// It speaks the Discord local RPC protocol over the platform IPC socket
// (a named pipe on Windows, a Unix domain socket elsewhere) using only
// node:net. It never discloses local paths, prompts, tokens or secrets.
// Every failure is silent: if Discord is not running or the socket is
// unreachable, all operations become no-ops.

import net from "node:net"
import os from "node:os"
import path from "node:path"

/** Discord client id for Matrix Code. Set at build time; a placeholder is safe. */
export const MATRIX_DISCORD_CLIENT_ID = "matrix-code"

const OP_HANDSHAKE = 0
const OP_FRAME = 1
const OP_CLOSE = 2

interface IpcRecord {
  op: number
  data?: unknown
}

/** Throttle how often we push the same activity to avoid spamming the socket. */
const SEND_DEBOUNCE_MS = 5000

export interface PresenceStatus {
  mode: "IDLE" | "LISTENING" | "THINKING" | "CODING" | "TESTING" | "BUILDING" | "REVIEWING" | "ERROR" | "DONE"
  projectName?: string
  profile?: string
  startedAt?: number
  repositoryUrl?: string
}

export interface DiscordPresenceOptions {
  clientID: string
  showProjectName: boolean
  showModelProfile: boolean
  showElapsedTime: boolean
  showRepositoryButton: boolean
}

function ipcPath(): string | null {
  if (process.platform === "win32") {
    return `\\\\?\\pipe\\discord-ipc-0`
  }
  const home = os.homedir()
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "discord", "ipc-0")
  return path.join(process.env.XDG_RUNTIME_DIR ?? home, "discord-ipc-0")
}

function encode(record: IpcRecord): Buffer {
  const data = Buffer.from(JSON.stringify(record.data ?? {}), "utf8")
  const header = Buffer.alloc(8)
  header.writeInt32LE(record.op, 0)
  header.writeInt32LE(data.length, 4)
  return Buffer.concat([header, data])
}

function readFrame(socket: net.Socket, callback: (record: IpcRecord) => void): void {
  let buffer = Buffer.alloc(0)
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    while (buffer.length >= 8) {
      const length = buffer.readInt32LE(4)
      if (buffer.length < 8 + length) break
      const op = buffer.readInt32LE(0)
      const payload = buffer.subarray(8, 8 + length).toString("utf8")
      buffer = buffer.subarray(8 + length)
      let data: unknown
      try {
        data = JSON.parse(payload)
      } catch {
        data = undefined
      }
      callback({ op, data })
    }
  })
}

/**
 * A connection to the Discord local RPC socket. All methods are fire-and-forget
 * and never throw to the caller; errors are swallowed so an unavailable Discord
 * has zero impact on Matrix Code.
 */
export class DiscordPresenceClient {
  private socket: net.Socket | null = null
  private ready = false
  private disposed = false
  private lastActivityKey = ""
  private lastSentAt = 0

  constructor(private readonly options: DiscordPresenceOptions) {}

  connect(): void {
    if (this.disposed) return
    const socketPath = ipcPath()
    if (!socketPath) return
    const socket = net.createConnection(socketPath)
    this.socket = socket
    socket.on("error", () => this.teardown(socket))
    socket.on("close", () => this.teardown(socket))
    readFrame(socket, (record) => {
      if (record.op === OP_FRAME && (record.data as { cmd?: string })?.cmd === "DISPATCH") {
        // HELLO received, handshake with our client id.
        this.send({ op: OP_HANDSHAKE, data: { v: 1, client_id: this.options.clientID } })
      } else if (record.op === OP_CLOSE) {
        this.teardown(socket)
      }
    })
    this.ready = true
  }

  setStatus(status: PresenceStatus): void {
    if (!this.ready || this.disposed || !this.socket) return

    const activity = buildActivity(status, this.options)
    const key = JSON.stringify(activity)
    if (key === this.lastActivityKey && Date.now() - this.lastSentAt < SEND_DEBOUNCE_MS) return
    this.lastActivityKey = key
    this.lastSentAt = Date.now()
    this.send({
      op: OP_FRAME,
      data: {
        cmd: "SET_ACTIVITY",
        nonce: `${Date.now()}`,
        args: { pid: process.pid, activity },
      },
    })
  }

  private send(record: IpcRecord): void {
    if (!this.socket) return
    try {
      this.socket.write(encode(record))
    } catch {
      // silent
    }
  }

  private teardown(socket: net.Socket): void {
    if (this.socket === socket) {
      this.socket = null
      this.ready = false
      try {
        socket?.destroy()
      } catch {
        // silent
      }
    }
  }

  close(): void {
    this.disposed = true
    try {
      this.socket?.end()
      this.socket?.destroy()
    } catch {
      // silent
    }
    this.socket = null
    this.ready = false
  }
}

function buildActivity(status: PresenceStatus, options: DiscordPresenceOptions) {
  const details = modeLabel(status.mode)
  let state = "Matrix Code"
  if (options.showModelProfile && status.profile) state = `Profile: ${status.profile}`
  else if (options.showProjectName && status.projectName) state = `Working on: ${status.projectName}`

  const result: Record<string, unknown> = {
    type: 4,
    details,
    state,
    timestamps: options.showElapsedTime && status.startedAt
      ? { start: status.startedAt * 1000 }
      : undefined,
  }

  if (options.showProjectName && status.projectName) {
    result.name = status.projectName
  }

  let buttons: Array<{ label: string; url: string }> | undefined
  if (options.showRepositoryButton && status.repositoryUrl) {
    buttons = [{ label: "Open repository", url: status.repositoryUrl }]
  }
  if (buttons && buttons.length > 0) result.buttons = buttons

  return result
}

export function modeLabel(mode: PresenceStatus["mode"]): string {
  switch (mode) {
    case "IDLE":
      return "Matrix Code"
    case "LISTENING":
      return "Listening…"
    case "THINKING":
      return "Thinking…"
    case "CODING":
      return "Coding"
    case "TESTING":
      return "Testing"
    case "BUILDING":
      return "Building"
    case "REVIEWING":
      return "Reviewing"
    case "ERROR":
      return "Error"
    case "DONE":
      return "Done"
  }
}
