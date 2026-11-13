/**
 * Who a connector action reaches, what it changes and what it carries, read off
 * the call's own input, for two uses:
 *
 * - the ask names the recipients and the start of the content, so the user
 *   approves this message to these people rather than "a send";
 * - the once-per-task grant of a send or a change is keyed by the tool AND the
 *   target (`grantKey`), so approving a note to a colleague, or an edit of one
 *   file, does not let the same tool reach anyone or anything else for the next
 *   half hour.
 *
 * Recipients are the fields whose name says so (`to`, `cc`, `recipient`,
 * `email`, `channel`, `chat_id`, `receive_id`, `phone`, …), at any depth.
 * The calling identity (`account`, `user_id`, `userId`) is not a recipient: it
 * says who is acting, not whom it reaches or what it touches. Content is the
 * text-like fields (`text`, `content`, `body`, `subject`, …); it is shown, never
 * part of the key, so a second message to the same person is covered.
 *
 * What the key holds depends on the action. A send is keyed by its recipients
 * (and the identity). A change is keyed by everything in the call that is not
 * content: the object it modifies (`file_id`, `path`, …) and any recipients.
 * When the target cannot be identified (no recipient for a send; no recipient
 * and no field naming the object for a change), `grantKey` is null and the call
 * is asked every time: an account or an empty target set is never a target.
 */

import { toolNameWords, type ConnectorActionKind } from './connectorActionPolicy';

export interface ConnectorActionTarget {
  /** The recipients as the call names them, in input order, without repeats. */
  recipients: string[];
  /** The start of the content, on one line, or '' when the call carries none. */
  preview: string;
  /**
   * What the task grant of this call is keyed by, with the tool name, or null
   * when the call's target cannot be identified (or the action is asked every
   * time): the call is then never covered by an earlier approval.
   */
  grantKey: string | null;
}

/** Field-name words that mark a recipient (`chat_id` → chat, id). */
const RECIPIENT_WORDS = new Set([
  'to', 'cc', 'bcc', 'recipient', 'recipients', 'receiver', 'receivers', 'receive', 'email', 'emails',
  'address', 'addresses', 'channel', 'channels', 'chat', 'chats', 'group', 'groups', 'room', 'rooms',
  'conversation', 'user', 'users', 'member', 'members', 'phone', 'phones', 'mobile', 'mobiles', 'target',
  'targets', 'contact', 'contacts', 'attendee', 'attendees', 'invitee', 'invitees', 'webhook', 'thread',
  'dest', 'destination', 'open', 'union', 'payee',
]);
/** Field-name words that mark the content. Checked first: `message_text` is content. */
const CONTENT_WORDS = new Set([
  'text', 'content', 'contents', 'body', 'message', 'msg', 'subject', 'title', 'markdown', 'html',
  'caption', 'comment', 'note', 'description', 'summary', 'card',
]);

/** Words of a field that names what the call modifies (`file_id`, `path`, `spreadsheetId`). */
const OBJECT_WORDS = new Set(['id', 'ids', 'key', 'keys', 'path', 'paths', 'url', 'uri', 'name', 'filename', 'slug', 'ref', 'uuid']);

const MAX_RECIPIENTS = 5;
const MAX_RECIPIENT_LENGTH = 60;
const MAX_PREVIEW_LENGTH = 80;

/** `msg_type`, `receive_id_type`, `parse_mode`: settings of a field, not the field. */
const SETTING_WORDS = new Set(['type', 'format', 'mode', 'kind', 'encoding']);

/** The calling identity: `account`, `account_id`, `user_id`, `userId` (`target_user_id` names whom, not who). */
function isIdentityField(words: string[]): boolean {
  return words.some((word) => word === 'account' || word === 'accounts' || word === 'accountid') || words.join('') === 'userid';
}

function fieldKind(key: string): 'recipient' | 'identity' | 'content' | 'object' | 'other' {
  const words = toolNameWords(key);
  if (words.some((word) => SETTING_WORDS.has(word))) return 'other';
  const last = words[words.length - 1];
  const isId = last === 'id' || last === 'ids';
  if (isIdentityField(words)) return 'identity';
  // `message_id` names a message to act on, not the text of one.
  if (words.some((word) => CONTENT_WORDS.has(word))) return isId ? 'other' : 'content';
  if (words.some((word) => RECIPIENT_WORDS.has(word))) return 'recipient';
  return OBJECT_WORDS.has(last) ? 'object' : 'other';
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
 * One scalar of the call that is neither content nor a recipient: where it
 * stands, what its field is, and its value.
 */
interface CallScalar {
  path: string;
  kind: 'identity' | 'object' | 'other';
  value: string;
}

/**
 * Every non-content, non-recipient scalar of the call, at any depth. A content
 * field's own text stays out (a second message to the same place is covered),
 * but a container under a content name (`message`) is still read field by
 * field: a target hidden in `{ message: { routing_key } }` must show up.
 */
function callScalars(value: unknown, field = '', path = '', depth = 0): CallScalar[] {
  if (depth > MAX_DEPTH) return [];
  if (isContainer(value)) {
    const out: CallScalar[] = [];
    for (const [key, child] of childrenOf(value)) {
      // The items of a list belong to the list's own field.
      const childField = Array.isArray(value) ? field : key;
      if (!Array.isArray(value) && fieldKind(key) === 'recipient') continue;
      out.push(...callScalars(child, childField, path ? `${path}.${key}` : key, depth + 1));
    }
    return out;
  }
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return [];
  const kind = fieldKind(field);
  if (kind === 'content' || kind === 'recipient') return [];
  return [{ path, kind, value: String(value) }];
}

const scalarKey = (scalar: CallScalar) => `${scalar.path}=${scalar.value}`;

export function describeConnectorTarget(input: Record<string, unknown>, action: ConnectorActionKind): ConnectorActionTarget {
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
  return {
    recipients,
    preview: content.length > 0 ? oneLine(content.join(' '), MAX_PREVIEW_LENGTH) : '',
    grantKey: grantKeyOf(input, recipients, action),
  };
}

/**
 * The key of a reusable grant, or null when the call is asked every time.
 * A send is keyed by its recipients and the acting identity. A change is keyed
 * by all of the call that is not content: the object it modifies, the
 * identity, any recipients. Either needs a target it can name: a recipient, or
 * (for a change) a field that names the modified object. The identity alone,
 * or nothing, is never a target.
 */
function grantKeyOf(input: Record<string, unknown>, recipients: string[], action: ConnectorActionKind): string | null {
  if (action !== 'send' && action !== 'change') return null;
  const scalars = callScalars(input);
  const identity = scalars.filter((scalar) => scalar.kind === 'identity').map(scalarKey).sort();
  const named = recipients.map((recipient) => recipient.toLowerCase()).sort();
  if (action === 'send') {
    return named.length > 0 ? JSON.stringify({ recipients: named, identity }) : null;
  }
  const objects = scalars.filter((scalar) => scalar.kind !== 'identity').map(scalarKey).sort();
  const namesObject = scalars.some((scalar) => scalar.kind === 'object');
  return named.length > 0 || namesObject ? JSON.stringify({ recipients: named, identity, objects }) : null;
}

/** The recipients as the ask lists them: at most five, each cut short. */
export function shownRecipients(target: ConnectorActionTarget): { shown: string[]; more: number } {
  return {
    shown: target.recipients.slice(0, MAX_RECIPIENTS).map((recipient) => oneLine(recipient, MAX_RECIPIENT_LENGTH)),
    more: Math.max(0, target.recipients.length - MAX_RECIPIENTS),
  };
}
