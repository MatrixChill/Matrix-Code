export * as ConfigMatrix from "./matrix"

import { Schema } from "effect"

// Matrix profile identifiers. The user picks a PROFILE, the router maps it to a
// concrete provider/model. "matrix-free-coding", "matrix-auto", "matrix-fast",
// "matrix-vision" and "matrix-local" correspond to the OmniRoute routes the setup
// dialog writes (id auto/coding, auto, auto/fast) plus future vision/local routes.
export const Profile = Schema.Union([
  Schema.Literal("smart"),
  Schema.Literal("coding-max"),
  Schema.Literal("reliable"),
  Schema.Literal("fast"),
  Schema.Literal("vision"),
  Schema.Literal("free"),
  Schema.Literal("local"),
])

// Optional Discord rich presence. Privacy-first and disabled by default; it is
// never a hard dependency of the core.
export class DiscordPresence extends Schema.Class<DiscordPresence>("ConfigV2.Matrix.DiscordPresence")({
  enabled: Schema.Boolean.pipe(Schema.optional).pipe(
    Schema.annotate({ description: "Enable Discord rich presence" }),
  ),
  showProjectName: Schema.Boolean.pipe(Schema.optional).pipe(
    Schema.annotate({ description: "Show the project name in presence" }),
  ),
  showModelProfile: Schema.Boolean.pipe(Schema.optional).pipe(
    Schema.annotate({ description: "Show the active Matrix profile in presence" }),
  ),
  showElapsedTime: Schema.Boolean.pipe(Schema.optional).pipe(
    Schema.annotate({ description: "Show the elapsed session time in presence" }),
  ),
  showRepositoryButton: Schema.Boolean.pipe(Schema.optional).pipe(
    Schema.annotate({ description: "Show the repository button in presence" }),
  ),
}) {}

export class Info extends Schema.Class<Info>("ConfigV2.Matrix")({
  profile: Profile.pipe(Schema.optional).pipe(
    Schema.annotate({ description: "Active Matrix profile" }),
  ),
  // Provider ID + model ID to use for the vision profile when the active model
  // lacks vision capability. Left empty, the router falls back to any model that
  // advertises vision.
  visionModel: Schema.String.pipe(Schema.optional).pipe(
    Schema.annotate({ description: "provider/model used for the Matrix Vision profile" }),
  ),
  // Local profile: provider ID for Ollama / LM Studio / llama.cpp / OpenAI-compatible.
  localProvider: Schema.String.pipe(Schema.optional).pipe(
    Schema.annotate({ description: "Provider used for the Matrix Local profile" }),
  ),
  discordPresence: DiscordPresence.pipe(Schema.optional),
  // Cooldown in ms before a failed model may be retried.
  cooldownMs: Schema.Number.pipe(Schema.optional).pipe(
    Schema.annotate({ description: "Cooldown in ms before a failed model may be retried" }),
  ),
}) {}
