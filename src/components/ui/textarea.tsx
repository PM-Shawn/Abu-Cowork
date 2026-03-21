import * as React from "react"

import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "w-full min-h-20 px-3 py-2 bg-[var(--abu-bg-muted)] border border-[var(--abu-border)] rounded-lg",
        "text-sm text-[var(--abu-text-primary)]",
        "placeholder:text-[var(--abu-text-placeholder)]",
        "focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)]",
        "disabled:pointer-events-none disabled:opacity-50",
        "transition-all resize-y",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
