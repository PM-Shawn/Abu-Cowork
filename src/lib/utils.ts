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
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      // Abu's 8 custom font-size tokens (index.css @theme --text-*)
      "font-size": [{ text: ["caption", "minor", "body", "h-xs", "h-sm", "h-md", "h-lg", "h-xl"] }],
      // In this codebase every `text-[var(--…)]` arbitrary value is a color, never a size
      "text-color": [{ text: [(v: string) => /^\[var\(--/.test(v)] }],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}
