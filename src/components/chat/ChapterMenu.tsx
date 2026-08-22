import { useEffect, useRef, useState } from 'react';
import { History } from 'lucide-react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import type { Chapter } from './chapters';

/**
 * The chapter rail's stand-in for narrow windows.
 *
 * The transcript column is centred with a fixed max width, so once the sidebar
 * and the preview panel are both open there is no gutter left to hold the rail
 * without it sitting on the messages. Rather than let the rail overlap the
 * text, ChatView drops it below that width and mounts this instead: the same
 * chapters, reached from a header button.
 *
 * The trigger is icon-only: a history glyph, which reads as "go back to an
 * earlier part of this conversation" — what the list is actually for — rather
 * than as a generic list of things to pick from.
 */
export default function ChapterMenu({
  chapters,
  currentIndex,
  onJump,
}: {
  chapters: Chapter[];
  currentIndex: number;
  onJump: (chapter: Chapter) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  if (chapters.length === 0) return null;

  return (
    <div ref={rootRef} className="relative ml-auto">
      <button
        type="button"
        aria-label={t.chat.chapters.openList}
        aria-expanded={open}
        title={t.chat.chapters.openList}
        onClick={() => setOpen((v) => !v)}
        // Same recipe as the window controls in WindowTitleBar (CONTROL_CLASS)
        // so this button sits at the same visual weight as the panel toggles
        // it shares a row with — including strokeWidth 1.5 on the glyph, which
        // is what actually separates "same colour" from "looks the same".
        className="btn-ghost flex items-center justify-center p-1 rounded-md
                   text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)]
                   focus-visible:outline-2 focus-visible:outline-[var(--abu-clay)] focus-visible:outline-offset-2"
      >
        <History className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
      </button>

      {open && (
        <div
          role="menu"
          aria-label={t.chat.chapters.railLabel}
          className="absolute right-0 top-[30px] z-20 min-w-[232px] max-h-[320px] overflow-y-auto p-1.5
                     rounded-xl bg-[var(--abu-bg-base)] border border-[var(--abu-border)] shadow-lg"
        >
          {chapters.map((chapter, index) => (
            <button
              key={chapter.messageId}
              type="button"
              role="menuitem"
              aria-current={index === currentIndex}
              onClick={() => { onJump(chapter); setOpen(false); }}
              className={cn(
                'flex items-center gap-2.5 w-full text-left px-2 py-1 rounded-lg text-minor',
                'hover:bg-[var(--abu-bg-hover)] hover:text-[var(--abu-text-primary)]',
                index === currentIndex ? 'text-[var(--abu-text-primary)]' : 'text-[var(--abu-text-tertiary)]',
              )}
            >
              {/* Same 5x2px tick as the rail — one visual language, one size. */}
              <span
                className={cn(
                  'flex-none w-[5px] h-[2px] rounded-[1px]',
                  index === currentIndex ? 'bg-[var(--abu-clay)]' : 'bg-[var(--abu-text-placeholder)]',
                )}
              />
              <span className="flex-1 truncate">{chapter.title}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
