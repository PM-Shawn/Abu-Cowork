export interface ComposerSelection {
  start: number;
  end: number;
}

export interface AgentMentionRange {
  start: number;
  end: number;
}

export type AgentMentionSource = 'inline' | 'leading-command';

export interface AgentMentionTarget {
  source: AgentMentionSource;
  range: AgentMentionRange;
  caret: number;
  query: string;
  key: string;
}

export interface LeadingAgentCommand extends AgentMentionTarget {
  source: 'leading-command';
  body: string;
}

const ASCII_EMAIL_LOCAL_PART = /[A-Za-z0-9._%+-]/;
const MENTION_NAME_CHARACTER = /[\p{L}\p{N}_-]/u;
const UNICODE_LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;

function clampOffset(offset: number, text: string): number {
  return Math.max(0, Math.min(offset, text.length));
}

function buildKey(source: AgentMentionSource, range: AgentMentionRange, caret: number, query: string): string {
  return `${source}:${range.start}-${range.end}:${caret}:${query}`;
}

function isMentionNameCharacter(character: string): boolean {
  return MENTION_NAME_CHARACTER.test(character);
}

function findMentionStart(text: string, caret: number): number | null {
  let index = caret;
  while (index > 0 && isMentionNameCharacter(text[index - 1])) index -= 1;
  return text[index - 1] === '@' ? index - 1 : null;
}

function findMentionEnd(text: string, atIndex: number): number {
  let end = atIndex + 1;
  while (end < text.length && isMentionNameCharacter(text[end])) end += 1;
  return end;
}

function isRejectedAtSign(text: string, atIndex: number): boolean {
  const previous = atIndex > 0 ? text[atIndex - 1] : '';
  const next = atIndex + 1 < text.length ? text[atIndex + 1] : '';
  if (previous === '@' || next === '@' || ASCII_EMAIL_LOCAL_PART.test(previous)) return true;

  // CJK prose is allowed to sit directly next to a mention ("帮我@publisher"),
  // but a Unicode local-part followed by a domain remains an email address.
  if (UNICODE_LETTER_OR_NUMBER.test(previous)) {
    const suffix = text.slice(atIndex + 1);
    if (/^[\p{L}\p{N}_-]+\.[\p{L}\p{N}-]+/u.test(suffix)) return true;
  }
  return false;
}

export function findAgentMentionTarget(
  text: string,
  selectionStart: number,
  selectionEnd: number,
): AgentMentionTarget | null {
  const start = clampOffset(selectionStart, text);
  const end = clampOffset(selectionEnd, text);
  if (start !== end) return null;

  const atIndex = findMentionStart(text, start);
  if (atIndex === null) return null;
  if (isRejectedAtSign(text, atIndex)) return null;

  const mentionEnd = findMentionEnd(text, atIndex);
  if (start > mentionEnd) return null;

  const query = text.slice(atIndex + 1, start).toLowerCase();
  const range = { start: atIndex, end: mentionEnd };
  return {
    source: 'inline',
    range,
    caret: start,
    query,
    key: buildKey('inline', range, start, query),
  };
}

export function parseLeadingAgentCommand(text: string): LeadingAgentCommand | null {
  const match = /^(\s*)@([\p{L}\p{N}_-]*)/u.exec(text);
  if (!match) return null;

  const atIndex = match[1].length;
  if (isRejectedAtSign(text, atIndex)) return null;

  const query = match[2].toLowerCase();
  const range = { start: atIndex, end: atIndex + query.length + 1 };
  // The command's identity must not depend on its body or the user's caret.
  const caret = range.end;
  return {
    source: 'leading-command',
    range,
    caret,
    query,
    body: text.slice(range.end).replace(/^\s+/, ''),
    key: buildKey('leading-command', range, caret, query),
  };
}

export function resolveAgentMentionReplacementRange(
  target: AgentMentionTarget,
  candidateName: string,
  text: string,
): AgentMentionRange {
  const candidateStart = target.range.start + 1;
  const candidateEnd = Math.min(text.length, candidateStart + candidateName.length);
  const candidateSlice = text.slice(candidateStart, candidateEnd);
  if (candidateSlice.toLowerCase() === candidateName.toLowerCase()) {
    return { start: target.range.start, end: candidateEnd };
  }
  return { start: target.range.start, end: target.caret };
}
