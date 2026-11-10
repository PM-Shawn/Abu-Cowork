/**
 * Who a connector action reaches and what it carries, read off the call's own
 * input, for two uses:
 *
 * - the ask names the recipients and the start of the content, so the user
 *   approves this message to these people rather than "a send";
 * - the once-per-task grant of a send is keyed by the tool AND the recipients
 *   (`recipientKey`), so approving a note to a colleague does not let the same
 *   tool send anything to anyone else for the next half hour.
 *
 * Recipients are the fields whose name says so (`to`, `cc`, `recipient`,
 * `email`, `channel`, `chat_id`, `receive_id`, `user_id`, `phone`, …), at the
 * top of the input or one object down (`{ message: { to } }`). When no field
 * says so, every field that is not content stands for the recipient in the
 * key: a tool whose target field has a name we do not know still asks again
 * when that field changes. Content is the text-like fields (`text`, `content`,
 * `body`, `subject`, …); it is shown, never part of the key, so a second
 * message to the same person is covered.
 */

import { toolNameWords } from './connectorActionPolicy';

export interface ConnectorActionTarget {
  /** The recipients as the call names them, in input order, without repeats. */
  recipients: string[];
  /** The start of the content, on one line, or '' when the call carries none. */
  preview: string;
  /** What the task grant of a send is keyed by, with the tool name. */
  recipientKey: string;
}

/** Field-name words that mark a recipient (`chat_id` → chat, id). */
const RECIPIENT_WORDS = new Set([
  'to', 'cc', 'bcc', 'recipient', 'recipients', 'receiver', 'receivers', 'receive', 'email', 'emails',
  'address', 'addresses', 'channel', 'channels', 'chat', 'chats', 'group', 'groups', 'room', 'rooms',
  'conversation', 'user', 'users', 'member', 'members', 'phone', 'phones', 'mobile', 'mobiles', 'target',
  'targets', 'contact', 'contacts', 'attendee', 'attendees', 'invitee', 'invitees', 'webhook', 'thread',
  'dest', 'destination', 'open', 'union', 'payee', 'account',
]);
/** Field-name words that mark the content. Checked first: `message_text` is content. */
const CONTENT_WORDS = new Set([
  'text', 'content', 'contents', 'body', 'message', 'msg', 'subject', 'title', 'markdown', 'html',
  'caption', 'comment', 'note', 'description', 'summary', 'card',
]);

const MAX_RECIPIENTS = 5;
const MAX_RECIPIENT_LENGTH = 60;
const MAX_PREVIEW_LENGTH = 80;

/** `msg_type`, `receive_id_type`, `parse_mode`: settings of a field, not the field. */
const SETTING_WORDS = new Set(['type', 'format', 'mode', 'kind', 'encoding']);

function fieldKind(key: string): 'recipient' | 'content' | 'other' {
  const words = toolNameWords(key);
  if (words.some((word) => SETTING_WORDS.has(word))) return 'other';
  const last = words[words.length - 1];
  const isId = last === 'id' || last === 'ids';
  // `message_id` names a message to act on, not the text of one.
  if (words.some((word) => CONTENT_WORDS.has(word))) return isId ? 'other' : 'content';
  if (words.some((word) => RECIPIENT_WORDS.has(word))) return 'recipient';
  return 'other';
}

/** One line, cut to `max` characters. */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** The readable values of a recipient field: strings, numbers, and the name/address of objects. */
function recipientValues(value: unknown): string[] {
  if (typeof value === 'string') return value.split(/[,;，；]/u).map((part) => part.trim()).filter(Boolean);
  if (typeof value === 'number' && Number.isFinite(value)) return [String(value)];
  if (Array.isArray(value)) return value.flatMap(recipientValues);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['email', 'address', 'emailAddress', 'id', 'name', 'value']) {
      const found = recipientValues(record[key]);
      if (found.length > 0) return found;
    }
  }
  return [];
}

/** The text of a content field (a string, or the text inside a rich-text object). */
function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join(' ');
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['text', 'content', 'body', 'title']) {
      const found = contentText(record[key]);
      if (found) return found;
    }
  }
  return '';
}

/** How deep the input is searched; a deeper value is not read (no real tool nests this far). */
const MAX_DEPTH = 8;

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return Boolean(value) && typeof value === 'object';
}

/** The entries of an object or array; an array's entries are keyed by their index. */
function childrenOf(value: Record<string, unknown> | unknown[]): Array<[string, unknown]> {
  return Array.isArray(value) ? value.map((item, index): [string, unknown] => [String(index), item]) : Object.entries(value);
}

/**
 * Scalars of everything that is not content, at any depth, for the fallback
 * key. A content field's own text stays out (a second message to the same
 * place is covered), but an object or list under a content name is still read:
 * a target hidden in `{ message: { dest_addr } }` must change the key.
 */
function otherScalars(value: unknown, path = '', depth = 0, inContent = false): string[] {
  if (depth > MAX_DEPTH) return [];
  if (isContainer(value)) {
    const out: string[] = [];
    for (const [key, child] of childrenOf(value)) {
      const content = inContent || (!Array.isArray(value) && fieldKind(key) === 'content');
      out.push(...otherScalars(child, path ? `${path}.${key}` : key, depth + 1, content));
    }
    return out.sort();
  }
  if (inContent) return [];
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return [`${path}=${String(value)}`];
  return [];
}

export function describeConnectorTarget(input: Record<string, unknown>): ConnectorActionTarget {
  const recipients: string[] = [];
  const content: string[] = [];
  const visit = (record: Record<string, unknown> | unknown[], depth: number) => {
    if (depth > MAX_DEPTH) return;
    for (const [key, value] of childrenOf(record)) {
      const kind = Array.isArray(record) ? 'other' : fieldKind(key);
      if (kind === 'recipient') {
        for (const found of recipientValues(value)) {
          if (!recipients.includes(found)) recipients.push(found);
        }
      } else if (kind === 'content') {
        // `{ message: { to, text } }` is a message object: its recipients count too.
        if (isContainer(value)) {
          const before = content.length;
          visit(value, depth + 1);
          if (content.length === before) {
            const text = contentText(value);
            if (text) content.push(text);
          }
        } else {
          const text = contentText(value);
          if (text) content.push(text);
        }
      } else if (isContainer(value)) {
        visit(value, depth + 1);
      }
    }
  };
  visit(input, 0);
  const recipientKey = recipients.length > 0
    ? JSON.stringify(recipients.map((recipient) => recipient.toLowerCase()).sort())
    : JSON.stringify(otherScalars(input));
  return {
    recipients,
    preview: content.length > 0 ? oneLine(content.join(' '), MAX_PREVIEW_LENGTH) : '',
    recipientKey,
  };
}

/** The recipients as the ask lists them: at most five, each cut short. */
export function shownRecipients(target: ConnectorActionTarget): { shown: string[]; more: number } {
  return {
    shown: target.recipients.slice(0, MAX_RECIPIENTS).map((recipient) => oneLine(recipient, MAX_RECIPIENT_LENGTH)),
    more: Math.max(0, target.recipients.length - MAX_RECIPIENTS),
  };
}
