import { describe, expect, test } from "bun:test"
import { MatrixReliable } from "@opencode-ai/core/matrix/reliable"
import { MatrixRouter } from "@opencode-ai/core/matrix/router"
import { MatrixCatalog } from "@opencode-ai/core/matrix/catalog"

const available = () => true

describe("MatrixReliable.classifyError", () => {
  test("retryable status codes", () => {
    expect(MatrixReliable.classifyError("429", "")).toBe("retry")
    expect(MatrixReliable.classifyError("503", "")).toBe("retry")
  })

  test("fallback status codes", () => {
    expect(MatrixReliable.classifyError("500", "")).toBe("fallback")
    expect(MatrixReliable.classifyError("504", "")).toBe("fallback")
  })

  test("permanent errors never fall back", () => {
    expect(MatrixReliable.classifyError("401", "")).toBe("none")
    expect(MatrixReliable.classifyError("403", "")).toBe("none")
    expect(MatrixReliable.classifyError("422", "")).toBe("none")
  })

  test("text-based classification", () => {
    expect(MatrixReliable.classifyError(undefined, "upstream request timeout")).toBe("fallback")
    expect(MatrixReliable.classifyError(undefined, "idle timeout occurred")).toBe("fallback")
    expect(MatrixReliable.classifyError(undefined, "connection refused")).toBe("fallback")
    expect(MatrixReliable.classifyError(undefined, "cannot connect to api")).toBe("fallback")
    expect(MatrixReliable.classifyError(undefined, "authentication failed")).toBe("none")
  })
})

describe("MatrixReliable.decideFailure", () => {
  test("permanent error stops without fallback", () => {
    const router = MatrixRouter.make()
    const outcome = MatrixReliable.decideFailure(
      "401",
      "",
      1,
      3,
      router,
      "reliable",
      MatrixCatalog.CATALOG,
      available,
    )
    expect(outcome.action).toBe("stop")
  })

  test("retryable error continues until attempts are exhausted", () => {
    const router = MatrixRouter.make()
    const within = MatrixReliable.decideFailure(
      "429",
      "",
      1,
      3,
      router,
      "reliable",
      MatrixCatalog.CATALOG,
      available,
    )
    expect(within.action).toBe("continue")
    const exhausted = MatrixReliable.decideFailure(
      "429",
      "",
      3,
      3,
      router,
      "reliable",
      MatrixCatalog.CATALOG,
      available,
    )
    expect(exhausted.action).toBe("fallback")
  })

  test("504 falls back immediately to another candidate", () => {
    const router = MatrixRouter.make()
    const outcome = MatrixReliable.decideFailure(
      "504",
      "Upstream idle timeout",
      1,
      3,
      router,
      "reliable",
      MatrixCatalog.CATALOG,
      available,
    )
    expect(outcome.action).toBe("fallback")
    expect(outcome.selection).toBeDefined()
  })

  test("no candidate available stops rather than looping", () => {
    const router = MatrixRouter.make()
    const outcome = MatrixReliable.decideFailure(
      "504",
      "timeout",
      1,
      3,
      router,
      "reliable",
      MatrixCatalog.CATALOG,
      () => false,
    )
    expect(outcome.action).toBe("stop")
  })
})
