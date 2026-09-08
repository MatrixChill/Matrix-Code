import { describe, expect, test } from "bun:test"
import { PasteFlow, pasteBytesToText, PASTE_SUPPRESSION_WINDOW_MS } from "../src/paste-flow"

describe("PasteFlow", () => {
  test("a fresh flow never suppresses", () => {
    const flow = new PasteFlow()
    expect(flow.shouldSkipBytes()).toBe(false)
    expect(flow.shouldSkipCommand()).toBe(false)
  })

  test("suppresses bytes while a command-driven paste is in flight", () => {
    const flow = new PasteFlow()
    flow.begin()
    expect(flow.shouldSkipBytes()).toBe(true)
    flow.end()
    expect(flow.shouldSkipBytes()).toBe(false)
  })

  test("keeps suppressing bytes when a clipboard read outlasts the debounce window", () => {
    const flow = new PasteFlow()
    flow.begin(1)
    expect(flow.shouldSkipBytes()).toBe(true)
  })

  test("suppresses overlapping command-driven pastes", () => {
    const flow = new PasteFlow()
    flow.begin()
    expect(flow.shouldSkipCommand()).toBe(true)
  })

  test("suppresses a command paste shortly after bytes were inserted", () => {
    const flow = new PasteFlow()
    flow.begin()
    flow.end()
    flow.markInserted()
    expect(flow.shouldSkipCommand()).toBe(true)
    expect(flow.shouldSkipCommand(Date.now() + PASTE_SUPPRESSION_WINDOW_MS)).toBe(false)
  })

  test("end clears the in-flight state before the window elapses", () => {
    const flow = new PasteFlow()
    flow.begin()
    flow.end()
    expect(flow.shouldSkipBytes()).toBe(false)
  })
})

describe("pasteBytesToText", () => {
  test("decodes byte arrays preserving the original text", () => {
    expect(pasteBytesToText(new TextEncoder().encode("hello paste"))).toBe("hello paste")
  })

  test("normalizes CRLF line endings", () => {
    expect(pasteBytesToText(new TextEncoder().encode("a\r\nb\r\nc"))).toBe("a\nb\nc")
  })

  test("normalizes bare CR line endings", () => {
    expect(pasteBytesToText(new TextEncoder().encode("line1\rline2"))).toBe("line1\nline2")
  })

  test("preserves multiline text as a single normalized string", () => {
    expect(pasteBytesToText(new TextEncoder().encode("alpha\nbeta\n\nomega"))).toBe("alpha\nbeta\n\nomega")
  })

  test("accepts plain strings untouched", () => {
    expect(pasteBytesToText("plain string")).toBe("plain string")
  })
})
