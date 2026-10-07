import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

/**
 * tailwind-merge configured for Abu's design tokens.
 *
 * Without this, twMerge misclassifies `text-[var(--abu-*)]` COLOR classes as
 * font-sizes and silently drops our custom size tokens from the same cn()
 * call (e.g. cn('text-caption', 'text-[var(--abu-info)]') → text-caption
 * eaten → element falls back to the 14px body default). Empirically verified;
 * regression-tested in utils.test.ts.
 * Design-system token names (tokens.css) are registered below for the same reason.
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
      // Legacy 8-token scale + design-system scale (index.css / tokens.css --text-*)
      "font-size": [{ text: [
        "caption", "minor", "body", "h-xs", "h-sm", "h-md", "h-lg", "h-xl",
        "title-lg", "title", "ui", "ui-sm", "h1", "h2", "h3", "mono", "code-inline",
      ] }],
      // `text-[var(--…)]` needs no validator here: tailwind-merge's default text-color group
      // already claims every arbitrary value before any extension is consulted
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
