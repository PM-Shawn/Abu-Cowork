import * as React from "react"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "w-full h-9 px-3 bg-[var(--abu-bg-muted)] border border-[var(--abu-border)] rounded-lg",
        "text-sm text-[var(--abu-text-primary)]",
        "placeholder:text-[var(--abu-text-placeholder)]",
        "focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)]",
        "disabled:pointer-events-none disabled:opacity-50",
        "transition-all",
        className
      )}
      {...props}
    />
  )
}

export { Input }
