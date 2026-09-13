import { RGBA, TextAttributes } from "@opentui/core"
import { For, type JSX } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { tint, useTheme } from "../context/theme"
import { getLogoForWidth } from "../logo"

export function Logo() {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const selectedLogo = () => getLogoForWidth(Math.max(0, dimensions().width - 4))

  const renderLine = (line: string, fg: RGBA, bold: boolean): JSX.Element[] => {
    const shadow = tint(theme.background, fg, 0.25)
    const attrs = bold ? TextAttributes.BOLD : undefined
    return Array.from(line).map((char) => {
      if (char === "_") {
        return (
          <text fg={fg} bg={shadow} attributes={attrs} selectable={false}>
            {" "}
          </text>
        )
      }
      if (char === "^") {
        return (
          <text fg={fg} bg={shadow} attributes={attrs} selectable={false}>
            ▀
          </text>
        )
      }
      if (char === "~") {
        return (
          <text fg={shadow} attributes={attrs} selectable={false}>
            ▀
          </text>
        )
      }
      if (char === ",") {
        return (
          <text fg={shadow} attributes={attrs} selectable={false}>
            ▄
          </text>
        )
      }
      return (
        <text fg={fg} attributes={attrs} selectable={false}>
          {char}
        </text>
      )
    })
  }

  return (
    <box>
      <For each={selectedLogo().left}>
        {(line, index) => (
          <box flexDirection="row" gap={selectedLogo().right[index()] ? 1 : 0}>
            <box flexDirection="row">{renderLine(line, RGBA.fromHex("#00FF66"), true)}</box>
            <box flexDirection="row">{renderLine(selectedLogo().right[index()], theme.text, true)}</box>
          </box>
        )}
      </For>
    </box>
  )
}
