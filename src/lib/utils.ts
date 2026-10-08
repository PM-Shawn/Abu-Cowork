import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

/**
 * tailwind-merge configured for the design tokens of tokens.css.
 *
 * tailwind-merge knows Tailwind's own names only. A `text-<word>` it does not know is read as a
 * text color, so a size token (`text-caption`) would be dropped by the color that follows it in
 * the same cn() call, and the element would fall back to the inherited size. Every token name is
 * therefore registered below under the property it sets; utils.test.ts holds a case per name.
 */
const DS_TEXT_COLORS = [
  "label", "label-secondary", "label-tertiary", "label-placeholder", "on-emphasis", "link",
  "success", "warning", "danger", "info", "brand-ink",
]
const DS_BG_COLORS = [
  "desk", "desk-solid", "surface", "raised", "code", "diagram-canvas", "page-canvas", "field",
  "fill", "fill-hover", "fill-selected", "fill-pressed", "emphasis", "scrim", "brand",
  "success-soft", "warning-soft", "danger-soft", "info-soft",
  "heat-1", "heat-2", "heat-3", "heat-4",
]

// A ds button writes the classes that answer the pointer as `not-aria-disabled:hover:…` /
// `not-aria-disabled:active:…`, so they are off while it is busy (ds/button-variants.ts). For
// merging, that variant is left out of the count: a caller's `hover:text-success` then replaces
// the button's `not-aria-disabled:hover:text-label` as it replaced `hover:text-label`. Kept side
// by side, the button's class would win under the pointer (one more selector part).
const BUSY_GATE = "not-aria-disabled"

const twMerge = extendTailwindMerge({
  experimentalParseClassName({ className, parseClassName }) {
    const parsed = parseClassName(className)
    if (!parsed.modifiers.includes(BUSY_GATE)) return parsed
    return { ...parsed, modifiers: parsed.modifiers.filter((modifier) => modifier !== BUSY_GATE) }
  },
  extend: {
    classGroups: {
      // The type scale (--text-*): interface sizes, then content sizes.
      "font-size": [{ text: [
        "caption", "title-lg", "title", "ui", "ui-sm",
        "body", "h1", "h2", "h3", "mono", "code-inline",
      ] }],
      "text-color": [{ text: DS_TEXT_COLORS }],
      "bg-color": [{ bg: DS_BG_COLORS }],
      "border-color": [{ border: ["separator", "control-border"] }],
      "ring-color": [{ ring: ["focus"] }],
      rounded: [{ rounded: ["window", "panel", "control"] }],
      shadow: [{ shadow: ["panel", "float", "dialog", "composer"] }],
      z: [{ z: ["sticky", "fullscreen", "popover", "dialog", "toast", "tooltip"] }],
      duration: [{ duration: ["fast", "base", "slow"] }],
      ease: [{ ease: ["enter", "exit"] }],
      "font-family": [{ font: ["code"] }],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}
