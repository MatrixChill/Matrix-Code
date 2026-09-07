import { decodePasteBytes } from "@opentui/core"

export const PASTE_SUPPRESSION_WINDOW_MS = 250

export class PasteFlow {
  private startedAt = 0
  private insertedAt = 0

  begin() {
    this.startedAt = Date.now()
  }

  end() {
    this.startedAt = 0
  }

  markInserted(now: number = Date.now()) {
    this.insertedAt = now
  }

  shouldSkipCommand(now: number = Date.now()): boolean {
    return now - this.insertedAt < PASTE_SUPPRESSION_WINDOW_MS
  }

  shouldSkipBytes(now: number = Date.now()): boolean {
    return this.startedAt !== 0 && now - this.startedAt < PASTE_SUPPRESSION_WINDOW_MS
  }
}

export function pasteBytesToText(bytes: Uint8Array | string): string {
  if (typeof bytes === "string") return bytes
  return decodePasteBytes(bytes).replace(/\r\n/g, "\n").replace(/\r/g, "\n")
}