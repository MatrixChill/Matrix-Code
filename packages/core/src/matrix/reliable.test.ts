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

    test("400 model is unavailable", () => {
      expect(
        MatrixReliable.classifyFailure("400", "Upstream request failed: Model is unavailable."),
      ).toBe("model_not_supported")
    })

    test("400 model unavailable without the auxiliary verb", () => {
      expect(MatrixReliable.classifyFailure("400", "model unavailable")).toBe("model_not_supported")
    })

    test("400 invalid parameter unrelated to model availability stays request_invalid", () => {
      expect(
        MatrixReliable.classifyFailure("400", "invalid parameter: max_tokens must be a positive integer"),
      ).toBe("request_invalid")
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

// A daily provider/account allowance that is spent arrives as an ordinary HTTP
// 429, and the body is the only thing that tells it apart from a transient rate
// limit. Cooling the single route that answered would spend the next attempt on
// its sibling, which draws on the same exhausted account.
describe("classifyFailure quota exhaustion", () => {
  const openRouterDaily = (message: string) =>
    `Provider request failed with HTTP 429: {"error":{"message":"${message}"}}`

  test("the OpenRouter free-models-per-day rejection is a spent allowance", () => {
    const text = openRouterDaily(
      "Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day.",
    )
    expect(MatrixReliable.classifyFailure("429", text)).toBe("quota_exhausted")
    // Recoverable: another provider can serve the request, so it must reach the
    // fallback path instead of stopping the request.
    expect(MatrixReliable.classifyError("429", text)).toBe("retry")
    // Route-scoped in the router: a spent allowance is not an outage, so it must
    // not take an unrelated backend down with it.
    expect(MatrixReliable.failureScope("quota_exhausted")).toBe("route")
  })

  test.each([
    "Rate limit exceeded: free-models-per-day",
    "You have exceeded your current quota, please check your plan",
    "insufficient_quota",
    "You have hit your daily limit for this model",
    "This account reached its per-day limit",
  ])("recognizes the allowance wording in %s", (message) => {
    expect(MatrixReliable.classifyFailure("429", message)).toBe("quota_exhausted")
  })

  test("a 429 without allowance wording keeps its transient classification", () => {
    expect(MatrixReliable.classifyFailure("429", "rate limited")).toBe("rate_limit")
    expect(MatrixReliable.classifyFailure("429", "Too many requests, please slow down")).toBe("rate_limit")
    expect(
      MatrixReliable.classifyFailure("429", "Provider request failed with HTTP 429: recoverable failure"),
    ).toBe("rate_limit")
  })

  test("allowance wording never reclassifies a structured status", () => {
    // 403 with quota wording is an authentication problem, 402 a payment one —
    // the allowance detector is confined to the 429 family so neither changes.
    expect(MatrixReliable.classifyFailure("403", "Free quota exceeded for this provider")).toBe("authentication")
    expect(MatrixReliable.classifyFailure("402", "quota exceeded")).toBe("payment_required")
    expect(MatrixReliable.classifyFailure(undefined, "quota exceeded")).toBe("quota_exhausted")
  })
})
