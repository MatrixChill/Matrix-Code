export const logo = {
  left: [
    "\u2588   \u2588   \u2588\u2588\u2588   \u2588\u2588\u2588\u2588\u2588  \u2588\u2588\u2588\u2588   \u2588\u2588\u2588\u2588\u2588  \u2588   \u2588",
    "\u2588\u2588 \u2588\u2588  \u2588   \u2588    \u2588    \u2588   \u2588    \u2588     \u2588 \u2588",
    "\u2588 \u2588 \u2588  \u2588\u2588\u2588\u2588\u2588    \u2588    \u2588\u2588\u2588\u2588     \u2588      \u2588",
    "\u2588   \u2588  \u2588   \u2588    \u2588    \u2588 \u2588      \u2588     \u2588 \u2588",
    "\u2588   \u2588  \u2588   \u2588    \u2588    \u2588  \u2588\u2588  \u2588\u2588\u2588\u2588\u2588  \u2588   \u2588",
  ],
  right: [
    "      \u2588\u2588\u2588\u2588   \u2588\u2588\u2588   \u2588\u2588\u2588\u2588   \u2588\u2588\u2588\u2588\u2588",
    "      \u2588      \u2588   \u2588  \u2588   \u2588  \u2588",
    "      \u2588      \u2588   \u2588  \u2588   \u2588  \u2588\u2588\u2588\u2588",
    "      \u2588      \u2588   \u2588  \u2588   \u2588  \u2588",
    "      \u2588\u2588\u2588\u2588   \u2588\u2588\u2588   \u2588\u2588\u2588\u2588   \u2588\u2588\u2588\u2588\u2588",
  ],
}

export const compactLogo = {
  left: ["MATRIX"],
  right: [" CODE"],
}

export const simpleLogo = {
  left: ["MATRIX CODE"],
  right: [""],
}

export const minimalLogo = {
  left: ["M"],
  right: [""],
}

export type LogoDefinition = typeof logo

const logoWidth = (value: LogoDefinition) =>
  Math.max(...value.left.map((line, index) => line.length + (value.right[index] ? 1 : 0) + (value.right[index]?.length ?? 0)))

export const logoWidths = {
  full: logoWidth(logo),
  compact: logoWidth(compactLogo),
  simple: logoWidth(simpleLogo),
}

export function getLogoForWidth(width: number): LogoDefinition {
  if (width >= logoWidths.full) return logo
  if (width >= logoWidths.compact) return compactLogo
  if (width >= logoWidths.simple) return simpleLogo
  return minimalLogo
}

export const go = {
  left: ["      ", "\u2588\u2588\u2588\u2588\u2588", "  \u2588  ", "\u2588\u2588\u2588\u2588\u2588"],
  right: ["      ", "\u2588\u2588\u2588\u2588", "\u2588   \u2588", "\u2588\u2588\u2588\u2588"],
}

export const marks = "_^~,"