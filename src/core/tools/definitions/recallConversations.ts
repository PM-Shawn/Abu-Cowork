/**
 * Conversation side of the recall tool: full-text search over past
 * conversations and a paged read of one found conversation. Pure functions
 * over data the caller passes in, so the rules are unit-testable without a
 * store or disk.
 */
import type { Message } from '../../../types';
import type { SearchHit } from '../../session/conversationStorage';
import { format } from '../../../i18n';
import type { TranslationDict } from '../../../i18n/types';

type RecallText = TranslationDict['toolResult']['recall'];

/** Catalog rows asked for per phrase, as a multiple of the wanted hits: the current conversation and rows of conversations no longer in the index are dropped afterwards. */
const SEARCH_OVERFETCH = 3;
/** Most characters of conversation text on one page. */
export const READ_PAGE_CHAR_BUDGET = 6000;
/** Most characters of one message on one page; a longer message continues in the next segments. */
export const READ_MESSAGE_CHAR_LIMIT = 1500;
/** Most segments on one page. */
export const READ_PAGE_MAX_MESSAGES = 40;
/** Most characters of a search snippet. */
const SNIPPET_CHAR_LIMIT = 200;

/** The index entry of `id`, else undefined. */
export function findConversation<T>(index: Record<string, T>, id: string): T | undefined {
  // Own-property lookup: an id such as "__proto__" or "constructor" is not a conversation.
  return Object.prototype.hasOwnProperty.call(index, id) ? index[id] : undefined;
}

/** Snippets mark the match with control characters (STX/ETX) for the search window; the model gets plain text. */
export function cleanSnippet(snippet: string): string {
  const plain = snippet.split('\u0002').join('').split('\u0003').join('').replace(/\s+/g, ' ').trim();
  return cutText(plain, SNIPPET_CHAR_LIMIT).text;
}

/**
 * Catalog hits of one phrase, one per conversation, in rank order, for
 * conversations that are in the index (a catalog row whose conversation is
 * gone from the index is stale) and are not `excludeConversationId` (the
 * conversation asking: it always contains its own question).
 */
export async function searchConversationHits<T>(
  phrase: string,
  index: Record<string, T>,
  limit: number,
  excludeConversationId: string | undefined,
  search: (query: string, limit: number) => Promise<SearchHit[]>,
): Promise<Array<{ meta: T; hit: SearchHit }>> {
  const hits = await search(phrase, limit * SEARCH_OVERFETCH);
  return keepIndexedHits(hits.filter((h) => h.conv_id !== excludeConversationId), index, limit);
}

/** The first `limit` hits that are in the index, one per conversation, in the order given. */
export function keepIndexedHits<T>(
  hits: readonly SearchHit[],
  index: Record<string, T>,
  limit: number,
): Array<{ meta: T; hit: SearchHit }> {
  const seen = new Set<string>();
  const kept: Array<{ meta: T; hit: SearchHit }> = [];
  for (const hit of hits) {
    if (kept.length >= limit) break;
    if (seen.has(hit.conv_id)) continue;
    const meta = findConversation(index, hit.conv_id);
    if (!meta) continue;
    seen.add(hit.conv_id);
    kept.push({ meta, hit });
  }
  return kept;
}

/** Cut `text` to `limit` characters without splitting a surrogate pair; `rest` is how many characters were left out. */
function cutText(text: string, limit: number): { text: string; rest: number } {
  if (text.length <= limit) return { text, rest: 0 };
  let end = limit;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), rest: text.length - end };
}

function messageText(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text' && typeof (part as { text?: unknown }).text === 'string')
    .map((part) => part.text)
    .join('\n');
}

/** The messages worth reading back: what the user and the assistant said. Tool output and system notes are left out. */
export function readableMessages(messages: readonly Message[]): Message[] {
  return messages.filter((m) => (m.role === 'user' || m.role === 'assistant') && !m.isSystem && messageText(m).trim().length > 0);
}

export interface ConversationPage {
  text: string;
  /** Offset to pass for the next page, or null at the end. */
  nextOffset: number | null;
}

interface Segment {
  role: 'user' | 'assistant';
  text: string;
  /** 0 for the first segment of a message. */
  part: number;
  /** Characters of the same message that follow this segment. */
  rest: number;
}

/**
 * The readable messages cut into segments of at most READ_MESSAGE_CHAR_LIMIT
 * characters, in order. A short message is one segment; a long one is several,
 * so following the offsets reaches every character of it exactly once.
 */
function toSegments(messages: readonly Message[]): Segment[] {
  const segments: Segment[] = [];
  for (const message of readableMessages(messages)) {
    let remaining = messageText(message).trim();
    let part = 0;
    do {
      const cut = cutText(remaining, READ_MESSAGE_CHAR_LIMIT);
      segments.push({ role: message.role as 'user' | 'assistant', text: cut.text, part, rest: cut.rest });
      remaining = remaining.slice(cut.text.length);
      part += 1;
    } while (remaining.length > 0);
  }
  return segments;
}

/**
 * One page of a conversation: segments from `offset` (0-based) until the page
 * budget is used. Always makes progress (a page holds at least one segment).
 */
export function renderConversationPage(
  input: { id: string; title: string; messages: readonly Message[]; offset: number },
  t: RecallText,
): ConversationPage {
  const all = toSegments(input.messages);
  const total = all.length;
  const { id, title } = input;
  if (total === 0) {
    return { text: format(t.convReadEmpty, { title }), nextOffset: null };
  }
  const offset = Number.isFinite(input.offset) ? Math.max(0, Math.floor(input.offset)) : 0;
  if (offset >= total) {
    return { text: format(t.convReadOffsetBeyond, { offset, total }), nextOffset: null };
  }

  const lines: string[] = [];
  let used = 0;
  let index = offset;
  while (index < total && index - offset < READ_PAGE_MAX_MESSAGES) {
    const segment = all[index];
    const role = segment.role === 'user' ? t.convReadUser : t.convReadAssistant;
    const label = segment.part === 0 ? role : format(t.convReadContinued, { role });
    const note = segment.rest > 0 ? ` ${format(t.convReadTruncated, { count: segment.rest })}` : '';
    const line = `${label}: ${segment.text}${note}`;
    if (lines.length > 0 && used + line.length > READ_PAGE_CHAR_BUDGET) break;
    lines.push(line);
    used += line.length;
    index += 1;
  }

  const header = format(t.convReadHeader, { title, id, from: offset + 1, to: index, total });
  const footer = index < total ? format(t.convReadNext, { id, offset: index }) : t.convReadEnd;
  return { text: `${header}\n\n${lines.join('\n\n')}\n\n${footer}`, nextOffset: index < total ? index : null };
}
