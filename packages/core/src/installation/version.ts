declare global {
  const OPENCODE_VERSION: string
  const OPENCODE_CHANNEL: string
}

export const InstallationVersion = typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : "local"
export const InstallationChannel = typeof OPENCODE_CHANNEL === "string" ? OPENCODE_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"

// Matrix v1.0.2 must never contact or install from the upstream OpenCode updater.
// Keep the updater implementation available for a future explicitly designed Matrix release.
export const InstallationAutoUpdateDisabled = true
