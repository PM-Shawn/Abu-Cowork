import { cn } from '@/lib/utils';

/**
 * Prompt grid shared by the default scenario guide and the expert / team
 * welcome. Cells are equal width so chip size and position stay fixed
 * regardless of how long each suggestion is.
 */
export const PROMPT_GRID_CLASS = 'grid grid-cols-2 gap-2 scenario-prompts-grid';
export const PROMPT_ITEM_CLASS = cn(
  'text-left px-3.5 py-2.5 rounded-xl text-body leading-relaxed transition-all cursor-pointer',
  'border border-[var(--abu-border-subtle)] bg-[var(--abu-bg-muted)] text-[var(--abu-text-secondary)]',
  'hover:bg-[var(--abu-bg-hover)] hover:border-[var(--abu-border-hover)]',
  'active:scale-[0.98]',
  'scenario-prompt-item'
);
