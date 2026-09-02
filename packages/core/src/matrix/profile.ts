export * as MatrixProfile from "./profile"

import { Schema } from "effect"

// A user-facing Matrix profile. The user picks a profile; the router resolves it
// to a concrete provider/model from the catalog. A profile is an intent (fast,
// reliable, vision, ...), not a hardcoded model.
export const Profile = Schema.Union([
  Schema.Literal("smart"),
  Schema.Literal("coding-max"),
  Schema.Literal("reliable"),
  Schema.Literal("fast"),
  Schema.Literal("vision"),
  Schema.Literal("free"),
  Schema.Literal("local"),
])
export type Profile = typeof Profile.Type

export type ProfileID = Profile

// Weights used to rank catalog candidates for a given profile. Higher = more
// important for that profile. 0 means "ignore" unless nothing else qualifies.
export interface Weights {
  readonly coding: number
  readonly reasoning: number
  readonly speed: number
  readonly toolCalls: number
  readonly vision: number
  readonly cost: number
}

export const WEIGHTS: Readonly<Record<ProfileID, Weights>> = {
  smart: { coding: 3, reasoning: 3, speed: 2, toolCalls: 2, vision: 0, cost: 1 },
  "coding-max": { coding: 5, reasoning: 3, speed: 2, toolCalls: 4, vision: 0, cost: 1 },
  reliable: { coding: 3, reasoning: 4, speed: 1, toolCalls: 5, vision: 0, cost: 1 },
  fast: { coding: 2, reasoning: 1, speed: 5, toolCalls: 2, vision: 0, cost: 2 },
  vision: { coding: 2, reasoning: 2, speed: 2, toolCalls: 2, vision: 5, cost: 1 },
  free: { coding: 1, reasoning: 1, speed: 2, toolCalls: 1, vision: 0, cost: 5 },
  local: { coding: 2, reasoning: 2, speed: 1, toolCalls: 2, vision: 1, cost: 5 },
}

export const PROFILE_IDS: readonly ProfileID[] = [
  "smart",
  "coding-max",
  "reliable",
  "fast",
  "vision",
  "free",
  "local",
]

// Human-readable label + intent description for display.
export const LABELS: Readonly<Record<ProfileID, string>> = {
  smart: "Matrix Smart",
  "coding-max": "Matrix Coding Max",
  reliable: "Matrix Reliable",
  fast: "Matrix Fast",
  vision: "Matrix Vision",
  free: "Matrix Free",
  local: "Matrix Local",
}

export function isProfile(value: string): value is ProfileID {
  return (PROFILE_IDS as readonly string[]).includes(value)
}
