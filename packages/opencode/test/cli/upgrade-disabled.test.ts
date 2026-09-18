import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { InstallationAutoUpdateDisabled } from "@opencode-ai/core/installation/version"
import { upgrade } from "../../src/cli/upgrade"
import { cliIt } from "../lib/cli-process"

test("Matrix automatic updater exits before config, latest-version, or installer work", async () => {
  expect(InstallationAutoUpdateDisabled).toBe(true)
  expect(await upgrade()).toBeUndefined()
})

// The packaged Windows launcher runs `matrix upgrade` as a child process and
// forwards its exit code to the caller, so the refusal has to be observable:
// the CLI must exit nonzero rather than only printing the disabled notice.
// A bare process.exit() drops the code a handler sets, which reported success
// for a command that failed.
describe("matrix upgrade command", () => {
  cliIt.live(
    "exits nonzero and prints the disabled notice",
    ({ opencode }) =>
      Effect.gen(function* () {
        const r = yield* opencode.spawn(["upgrade"])
        opencode.expectExit(r, 1, "matrix upgrade")
        expect(r.stdout + r.stderr).toContain("self-update is disabled")
      }),
    60_000,
  )
})
