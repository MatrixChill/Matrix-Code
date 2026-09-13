import { expect, test } from "bun:test"
import { getLogoForWidth, logoWidths } from "../../../src/logo"

test("selects a logo variant that fits the available width", () => {
  expect(getLogoForWidth(logoWidths.full)).toBe(getLogoForWidth(logoWidths.full + 1))
  expect(getLogoForWidth(logoWidths.full - 1)).toBe(getLogoForWidth(logoWidths.compact))
  expect(getLogoForWidth(logoWidths.compact - 1)).toBe(getLogoForWidth(logoWidths.simple))
  expect(getLogoForWidth(logoWidths.simple - 1).left[0]).toBe("M")
})

test("never selects a logo wider than the available width", () => {
  for (let width = 0; width <= logoWidths.full + 10; width++) {
    const selected = getLogoForWidth(width)
    const renderedWidth = Math.max(
      ...selected.left.map((line, index) => line.length + (selected.right[index] ? 1 : 0) + (selected.right[index]?.length ?? 0)),
    )
    expect(renderedWidth).toBeLessThanOrEqual(Math.max(width, 1))
  }
})