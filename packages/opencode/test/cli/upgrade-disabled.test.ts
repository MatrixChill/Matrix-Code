import { expect, test } from "bun:test"
import { InstallationAutoUpdateDisabled } from "@opencode-ai/core/installation/version"
import { upgrade } from "../../src/cli/upgrade"

test("Matrix automatic updater exits before config, latest-version, or installer work", async () => {
  expect(InstallationAutoUpdateDisabled).toBe(true)
  expect(await upgrade()).toBeUndefined()
})
