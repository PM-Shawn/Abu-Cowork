import { useCallback, useRef, useState } from 'react';
import { useI18n, format } from '@/i18n';
import { cn } from '@/lib/utils';
import { CONDENSE_THRESHOLD, type Chapter } from './chapters';

/**
 * The conversation chapter rail — a column of tick marks in the transcript's
 * left gutter, one per chapter, with the current chapter highlighted. Hovering
 * a tick previews that chapter; clicking it jumps there.
 *
 * Two sizes carry the whole design and must not be conflated:
 *
 *   - the visible tick is 5x2px, small enough to stay ambient beside the text;
 *   - the button around it is 22x10px, because a 5x2px hit target cannot be
 *     clicked. Only the `::before` line changes size between states.
 *
 * The button height doubles as the row pitch (no flex gap), which is what lets
 * the condensed mode below shorten the rail without touching tick length.
 */

/** Every tick is the same length: length encodes nothing, so a glance at the
 *  rail reads as an even scale rather than a ragged bar chart. State is carried
 *  by colour (current) and weight (hover) instead. */
const TICK_BASE =
  'relative block w-[22px] h-[10px] border-0 p-0 bg-transparent cursor-pointer ' +
  "before:content-[''] before:absolute before:left-0 before:top-1/2 before:-translate-y-1/2 " +
  'before:w-[5px] before:h-[2px] before:rounded-[1px] before:bg-[var(--abu-text-placeholder)] ' +
  'before:opacity-75 before:transition-all before:duration-150 ' +
  'hover:before:w-[10px] hover:before:h-[3px] hover:before:bg-[var(--abu-text-primary)] hover:before:opacity-100 ' +
  'focus-visible:outline-2 focus-visible:outline-[var(--abu-clay)] focus-visible:outline-offset-2';

/** Condensed rows tighten the pitch only — the tick keeps its length, so a long
 *  conversation still reads as the same scale, just a denser one. */
const TICK_CONDENSED = 'h-[6px]';

const TICK_CURRENT = 'before:bg-[var(--abu-clay)] before:opacity-100';

export default function ChapterRail({
  chapters,
  currentIndex,
  onJump,
}: {
  chapters: Chapter[];
  currentIndex: number;
  onJump: (chapter: Chapter) => void;
}) {
  const { t } = useI18n();
  const [peeked, setPeeked] = useState<{ index: number; top: number } | null>(null);
  const tickRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // The preview card is aligned to the tick under the cursor, so it is measured
  // from the live element rather than computed from an index: the condensed
  // pitch means row height is not uniform, and an arithmetic guess would drift
  // further down the rail with every condensed row above it.
  const showPeek = useCallback((index: number) => {
    const tick = tickRefs.current[index];
    if (!tick) return;
    setPeeked({ index, top: tick.offsetTop - 10 });
  }, []);

  if (chapters.length === 0) return null;

  const condensed = chapters.length > CONDENSE_THRESHOLD;
  const preview = peeked ? chapters[peeked.index] : null;

  return (
    // Zero-height sticky dock, pinned to the vertical middle of the scrollport.
    // The rail must not be a plain absolute child of the scroll container:
    // absolute positioning resolves against the container's padding box and
    // therefore scrolls away with the content. Sticky keeps it in place — the
    // same trick the scroll-to-bottom button in ChatView already relies on —
    // and `top-1/2` parks it halfway down rather than under the header, so the
    // scale reads as centred on the conversation instead of hanging from it.
    <div className="sticky top-1/2 h-0 z-10">
      {/* Mirrors the message column's own `max-w-4xl mx-auto` box so the rail
          tracks the TEXT, not the window. Anchoring it to the scroll container
          instead put it (containerWidth - 896) / 2 pixels away from the column
          on any wide layout — out in the empty margin, where a 5x2px grey tick
          is effectively invisible. The rail then sits inside the column's own
          40px left padding, which is reserved at every realistic pane width. */}
      <div className="w-full max-w-4xl mx-auto relative">
        <nav
          aria-label={t.chat.chapters.railLabel}
          className="absolute left-1 -translate-y-1/2 py-1.5 px-1"
          onMouseLeave={() => setPeeked(null)}
        >
          <div className="flex flex-col items-start">
            {chapters.map((chapter, index) => (
              <button
                key={chapter.messageId}
                ref={(el) => { tickRefs.current[index] = el; }}
                type="button"
                aria-label={format(t.chat.chapters.jumpTo, { title: chapter.title })}
                aria-current={index === currentIndex}
                className={cn(
                  TICK_BASE,
                  // First and last always keep full pitch: they anchor the two
                  // ends of the scale, and condensing them would make the rail's
                  // top and bottom drift as the conversation grows.
                  condensed && index > 0 && index < chapters.length - 1 && TICK_CONDENSED,
                  index === currentIndex && TICK_CURRENT,
                )}
                onMouseEnter={() => showPeek(index)}
                onFocus={() => showPeek(index)}
                onBlur={() => setPeeked(null)}
                onClick={() => onJump(chapter)}
              />
            ))}
          </div>

          {preview && peeked && (
            <div
              className="absolute left-[calc(100%+10px)] w-[300px] flex flex-col gap-1 px-3 py-2.5 pointer-events-none
                         rounded-xl bg-[var(--abu-bg-base)] border border-[var(--abu-border)] shadow-lg"
              style={{ top: peeked.top }}
            >
              <span className="text-h-xs text-[var(--abu-text-primary)] truncate">{preview.title}</span>
              {preview.summary && (
                <span className="text-minor text-[var(--abu-text-muted)] line-clamp-3">{preview.summary}</span>
              )}
            </div>
          )}
        </nav>
      </div>
    </div>
  );
}
