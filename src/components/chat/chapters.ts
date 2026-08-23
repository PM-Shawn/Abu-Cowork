import type { Message } from '@/types';
import { getMessageText } from '@/core/context/contextUtils';
import { isCompactBoundary } from '@/core/context/compactBoundary';

/**
 * Chapters for the conversation rail — the left-hand tick scale that lets the
 * user jump back to an earlier stretch of a long conversation.
 *
 * Chapters are DERIVED, never stored: one chapter per user turn, read straight
 * off the groups `groupMessagesByLoop` already produces. That choice is load
 * bearing, not an implementation shortcut:
 *
 *   - every existing conversation gets a usable rail with no migration, and
 *   - the rail can never be empty, which a model-driven scheme cannot promise.
 *
 * Claude Code marks chapters purely by having the model call a `mark_chapter`
 * tool, and its main-process handler has no side effect at all — the UI reads
 * the tool call back out of the transcript. Reverse-engineering that build
 * showed the weakness of the design: a session spanning dozens of turns
 * carried two chapters, because the model simply does not call the tool often
 * enough. A later batch adds the same tool here, but only to *rename* a
 * derived chapter and attach a summary — the skeleton stays derived.
 *
 * Titles and summaries therefore always have a fallback: the user's own words
 * for the title, the assistant's first reply for the summary.
 */
export interface Chapter {
  /** Index into the `groupMessagesByLoop` array — what the rail scrolls to. */
  groupIndex: number;
  /** First message of the chapter; the scroll/highlight anchor. */
  messageId: string;
  /** Rail label. Derived from the user message that opens the chapter. */
  title: string;
  /** Hover-card body. Derived from the first assistant reply; may be empty. */
  summary: string;
}

/** Title budget. Long enough to disambiguate two similar asks, short enough
 *  that the hover card stays one line at the rail's 300px width. */
const TITLE_MAX = 24;
/** Summary budget. The card clamps to three lines; this keeps the DOM small
 *  without cutting so early that the clamp never has anything to hide. */
const SUMMARY_MAX = 120;

/**
 * First non-empty line of a message, without materialising the rest.
 *
 * `split('\n').map(trim)` reads better but allocates one string per line of
 * every message the rail summarises, and assistant replies run to dozens of
 * lines. This walks to the first line with content and stops — normally one
 * slice — which measured ~2.4x faster over a 500-turn conversation, on a path
 * that reruns for every streamed token.
 */
function firstNonEmptyLine(raw: string): string {
  let start = 0;
  while (start < raw.length) {
    let end = raw.indexOf('\n', start);
    if (end === -1) end = raw.length;
    const line = raw.slice(start, end).trim();
    if (line) return line;
    start = end + 1;
  }
  return '';
}

/**
 * First non-empty line, collapsed and truncated. Chat text is markdown, so a
 * message often opens with a heading or a list marker; those read poorly as a
 * label, but stripping markdown properly is a renderer's job. Taking the first
 * line and trimming common leading markers gets the useful 95% for one line of
 * UI text.
 */
function toLabel(raw: string, max: number): string {
  const firstLine = firstNonEmptyLine(raw);
  if (!firstLine) return '';
  const cleaned = firstLine.replace(/^(#{1,6}\s+|[-*+]\s+|>\s+|\d+\.\s+)/, '').trim();
  if (cleaned.length <= max) return cleaned;
  // Trim, then drop a trailing partial word so latin text doesn't break mid-word.
  // CJK has no spaces, so the slice stands as-is there — which is correct.
  return `${cleaned.slice(0, max).replace(/\s+\S*$/, '')}…`;
}

/** A message that can open a chapter: a real user turn, not a marker or a
 *  system injection that merely happens to sit at a group boundary. */
function opensChapter(message: Message): boolean {
  return message.role === 'user' && !message.isSystem && !isCompactBoundary(message);
}

/**
 * Derive the rail's chapters from the same groups the message list renders.
 *
 * Passing the groups rather than the raw messages is deliberate: the rail must
 * scroll to a Virtuoso index, and the only array whose indices mean anything to
 * Virtuoso is the one handed to `data`. Deriving from messages here would let
 * the two drift apart silently the next time grouping changes.
 *
 * `fallbackTitle` names the opening stretch of a conversation that begins with
 * something other than a user turn (a restored task, a recovery notice). It is
 * passed in rather than imported so this module stays free of i18n and remains
 * a pure function of its inputs.
 */
export function deriveChapters(groups: Message[][], fallbackTitle: string): Chapter[] {
  const chapters: Chapter[] = [];

  groups.forEach((group, groupIndex) => {
    const head = group[0];
    if (!head) return;

    // Groups that do not open with a user turn belong to the chapter already in
    // progress. Only when there is no such chapter do they start one, so the
    // rail still has a tick covering the top of the conversation.
    if (!opensChapter(head) && chapters.length > 0) return;

    const userMessage = group.find(opensChapter);
    const reply = group.find((m) => m.role === 'assistant' && !m.isSystem);

    chapters.push({
      groupIndex,
      messageId: head.id,
      title: (userMessage && toLabel(getMessageText(userMessage.content), TITLE_MAX)) || fallbackTitle,
      summary: reply ? toLabel(getMessageText(reply.content), SUMMARY_MAX) : '',
    });
  });

  return chapters;
}

/** One rendered message row, reduced to what the scroll-spy needs. */
export interface RowPosition {
  /** Virtuoso's `data-index` for the row — its index in the group array. */
  index: number;
  /** Row top, in pixels relative to the top of the scroll viewport. */
  top: number;
}

/**
 * Index of the group occupying the top of the viewport.
 *
 * Virtuoso's `rangeChanged` callback looks like the signal for this and is not:
 * it is derived from the RENDERED item range, which includes whatever
 * `increaseViewportBy` adds above the viewport. With 900px of top overscan any
 * conversation shorter than viewport + 1800px renders every row at once and
 * reports startIndex 0 forever, so a rail driven by it pins to the first
 * chapter and never moves. Row geometry is the honest input instead.
 *
 * `slack` lets a row count as "at the top" a few pixels before it strictly is,
 * so the chapter flips the moment its first row reaches the edge.
 *
 * `atBottom` is not a nicety — without it the LAST chapter can never be current.
 * Its first row only reaches the top edge when a viewport's worth of content
 * sits beneath it, and at the end of a conversation there never is, so a purely
 * top-anchored rule leaves the final tick permanently unlit however far the
 * user scrolls. Resting at the bottom means reading the newest chapter, so say
 * that directly rather than inferring it from geometry that cannot express it.
 */
export function topVisibleGroup(
  rows: RowPosition[],
  { atBottom = false, slack = 8 }: { atBottom?: boolean; slack?: number } = {},
): number {
  let top = 0;

  if (atBottom) {
    for (const row of rows) {
      if (Number.isFinite(row.index) && row.index > top) top = row.index;
    }
    return top;
  }

  for (const row of rows) {
    if (row.top > slack) break;
    if (Number.isFinite(row.index)) top = row.index;
  }
  return top;
}

/**
 * Below this many chapters the rail is not worth drawing.
 *
 * One or two ticks navigate nothing — the whole conversation is already on
 * screen — so the rail would be pure ornament next to the text. Three is the
 * first count where scrubbing beats scrolling.
 */
export const MIN_CHAPTERS_FOR_RAIL = 3;

/** Whether a conversation has enough chapters for the rail to earn its place. */
export function shouldShowRail(chapters: Chapter[]): boolean {
  return chapters.length >= MIN_CHAPTERS_FOR_RAIL;
}

/**
 * Above this many chapters the rail switches to its condensed pitch: the ticks
 * keep their length and only the row spacing tightens, so the rail's height
 * stops growing with the conversation instead of turning into a scrollbar of
 * its own. Exported so the rail and its tests agree on one number.
 */
export const CONDENSE_THRESHOLD = 12;

/**
 * Index of the chapter the viewport is currently inside, given the group at the
 * top of the viewport (see `topVisibleGroup`).
 *
 * The current chapter is the last one that has started at or above the top of
 * the viewport; before the first chapter starts, it is chapter 0. At the bottom
 * of a conversation that makes the newest chapter current, which is what the
 * rail should show on open — the app mounts scrolled to the newest message.
 */
export function activeChapterIndex(chapters: Chapter[], firstVisibleGroup: number): number {
  let active = 0;
  for (let i = 0; i < chapters.length; i++) {
    if (chapters[i].groupIndex <= firstVisibleGroup) active = i;
    else break;
  }
  return active;
}
