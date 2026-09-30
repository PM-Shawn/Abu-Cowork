import { memo } from 'react';
import { useI18n } from '@/i18n';
import { IconButton } from '@/components/ds/button';
import { AppIcons } from '@/components/ds/icons';
import { Menu, MenuRadioGroup, MenuRadioItem } from '@/components/ds/menu';
import { sameChapters, type Chapter } from './chapters';

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
 *
 * The chapters are a single-choice list (the current one is checked). The
 * menu's accessible name comes from its trigger button, which carries the same
 * words as the rail's `railLabel`.
 */
function ChapterMenu({
  chapters,
  currentIndex,
  onJump,
}: {
  chapters: Chapter[];
  currentIndex: number;
  onJump: (chapter: Chapter) => void;
}) {
  const { t } = useI18n();

  if (chapters.length === 0) return null;

  return (
    <Menu
      align="end"
      trigger={<IconButton size="sm" icon={AppIcons.history} label={t.chat.chapters.openList} className="ml-auto" />}
    >
      {/* A long conversation has many chapters; the list scrolls instead of growing past the window. */}
      <div className="max-h-80 overflow-y-auto">
        <MenuRadioGroup
          value={chapters[currentIndex]?.messageId ?? ''}
          onValueChange={(messageId) => {
            const chapter = chapters.find((item) => item.messageId === messageId);
            if (chapter) onJump(chapter);
          }}
        >
          {chapters.map((chapter) => (
            <MenuRadioItem key={chapter.messageId} value={chapter.messageId}>{chapter.title}</MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </div>
    </Menu>
  );
}

// ChatView re-renders on every streamed token and derives a new chapter array
// each time; the trigger's tooltip and the menu only re-render when a title or
// the current chapter changed. onJump reads only the position fields.
export default memo(ChapterMenu, (prev, next) =>
  prev.currentIndex === next.currentIndex
  && prev.onJump === next.onJump
  && sameChapters(prev.chapters, next.chapters, { summary: false }));
