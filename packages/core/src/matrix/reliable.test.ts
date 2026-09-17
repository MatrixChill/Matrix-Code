import { describe, expect, test } from "bun:test"
import { MatrixReliable } from "./reliable"

describe("classifyFailure", () => {
  // -----------------------------------------------------------------------
  // Free-tier restriction messages
  // -----------------------------------------------------------------------
  describe("restricted_external_route", () => {
    test("new observed OpenCode version-gate message (403)", () => {
      expect(
        MatrixReliable.classifyFailure(
          "403",
          "Error from provider (Console): OpenCode 1.18.0 or newer is required to use the free tier",
        ),
      ).toBe("restricted_external_route")
    })

    test("new observed OpenCode version-gate message (no status code)", () => {
      expect(
        MatrixReliable.classifyFailure(
          undefined,
          "Error from provider (Console): OpenCode 1.18.0 or newer is required to use the free tier",
        ),
      ).toBe("restricted_external_route")
    })

    test("previous known restriction format (403)", () => {
      expect(
        MatrixReliable.classifyFailure(
          "403",
          "OpenCode's free tier can only be used from within OpenCode",
        ),
      ).toBe("restricted_external_route")
    })

    test("previous known restriction format (400)", () => {
      expect(
        MatrixReliable.classifyFailure(
          "400",
          "OpenCode's free tier can only be used from within OpenCode",
        ),
      ).toBe("restricted_external_route")
    })
  })

  // -----------------------------------------------------------------------
  // Unrelated errors must NOT be classified as restricted_external_route
  // -----------------------------------------------------------------------
  describe("non-restricted errors", () => {
    test("401 auth error without free tier mention", () => {
      expect(MatrixReliable.classifyFailure("401", "Invalid API key")).toBe("authentication")
    })

    test("403 generic forbidden without opencode or free tier", () => {
      expect(MatrixReliable.classifyFailure("403", "Access denied")).toBe("authentication")
    })

    test("400 model not supported", () => {
      expect(
        MatrixReliable.classifyFailure("400", "model not supported: fake-model"),
      ).toBe("model_not_supported")
    })

    test("400 generic bad request", () => {
      expect(MatrixReliable.classifyFailure("400", "malformed request body")).toBe("request_invalid")
    })

    test("429 rate limit", () => {
      expect(MatrixReliable.classifyFailure("429", "rate limited")).toBe("rate_limit")
    })

    test("500 upstream failure", () => {
      expect(MatrixReliable.classifyFailure("500", "internal server error")).toBe("upstream_failure")
    })

    test("402 payment required", () => {
      expect(MatrixReliable.classifyFailure("402", "payment required")).toBe("payment_required")
    })

    test("message with 'free' but not 'opencode' is not restricted", () => {
      expect(
        MatrixReliable.classifyFailure("403", "Free quota exceeded for this provider"),
      ).toBe("authentication")
    })

    test("message with 'opencode' but not 'free tier' is not restricted", () => {
      expect(
        MatrixReliable.classifyFailure("403", "OpenCode authentication failed"),
      ).toBe("authentication")
    })
  })
})
