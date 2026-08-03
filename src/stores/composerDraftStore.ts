/**
 * Chat composer drafts have two lifetimes:
 *
 * - The complete draft (attachments, references, selected skill/agent) lives in
 *   this module's session Map. It survives React unmounts and conversation
 *   switches, but never writes image bytes or local file paths to disk.
 * - Plain text is persisted by Zustand so a draft also survives an app reload.
 *
 * Keeping those layers separate is intentional. Prompt text is the user-facing
 * recovery requirement; persisting screenshot base64 or local file metadata
 * would create a much larger and more sensitive on-disk cache.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ImageAttachment } from '@/types';
import type { ChatReference } from '@/types/chatReference';
import type { EnterpriseMode } from '@/core/enterprise/types';

const WELCOME_COMPOSER_DRAFT_SEGMENT = 'welcome';
const LEGACY_WELCOME_COMPOSER_DRAFT_KEY = WELCOME_COMPOSER_DRAFT_SEGMENT;
const CONVERSATION_COMPOSER_DRAFT_PREFIX = 'conversation:';

export const LOCAL_COMPOSER_DRAFT_SCOPE = 'local';
export const WELCOME_COMPOSER_DRAFT_KEY = `${LOCAL_COMPOSER_DRAFT_SCOPE}:${WELCOME_COMPOSER_DRAFT_SEGMENT}`;
export const COMPOSER_DRAFT_SAVE_DELAY_MS = 400;

const MAX_PERSISTED_TEXT_LENGTH = 100_000;
const MAX_PERSISTED_DRAFTS = 100;

export interface ComposerSuggestion {
  name: string;
  description: string;
  trigger?: string;
}

export interface ComposerFileAttachment {
  id: string;
  path: string;
  name: string;
}

export interface ComposerDraft {
  text: string;
  images: ImageAttachment[];
  files: ComposerFileAttachment[];
  references: ChatReference[];
  selectedSkill: ComposerSuggestion | null;
  selectedAgent: ComposerSuggestion | null;
}

interface PersistedComposerDraft {
  text: string;
  updatedAt: number;
}

interface ComposerDraftState {
  drafts: Record<string, PersistedComposerDraft>;
  setText: (key: string, text: string) => void;
  clear: (key: string) => void;
  clearAll: () => void;
}

export type ComposerDraftScope =
  | typeof LOCAL_COMPOSER_DRAFT_SCOPE
  | `enterprise:${string}:${string}`
  | `account:${string}`;

const sessionDrafts = new Map<string, ComposerDraft>();
// Deleting an active conversation and switching the composer happen in the
// same render cycle. Its unmount/key-change cleanup can therefore arrive
// after the store deletion. Tombstones make that stale flush a no-op instead
// of resurrecting an orphaned draft. Conversation ids are never reused.
const discardedDraftKeys = new Set<string>();

function emptyDraft(text = ''): ComposerDraft {
  return {
    text,
    images: [],
    files: [],
    references: [],
    selectedSkill: null,
    selectedAgent: null,
  };
}

function cloneDraft(draft: ComposerDraft): ComposerDraft {
  return {
    ...draft,
    images: [...draft.images],
    files: [...draft.files],
    references: [...draft.references],
  };
}

function hasSessionContent(draft: ComposerDraft): boolean {
  return draft.text.length > 0
    || draft.images.length > 0
    || draft.files.length > 0
    || draft.references.length > 0
    || draft.selectedSkill !== null
    || draft.selectedAgent !== null;
}

function pruneOldest(
  drafts: Record<string, PersistedComposerDraft>,
): Record<string, PersistedComposerDraft> {
  const entries = Object.entries(drafts);
  if (entries.length <= MAX_PERSISTED_DRAFTS) return drafts;
  entries.sort(([, a], [, b]) => b.updatedAt - a.updatedAt);
  return Object.fromEntries(entries.slice(0, MAX_PERSISTED_DRAFTS));
}

function encodeScopePart(value: string, fallback: string): string {
  const normalized = value.trim() || fallback;
  return encodeURIComponent(normalized);
}

/**
 * Enterprise bindings already carry stable organization and user ids. The
 * boundAt fallback keeps a malformed/transitional binding isolated instead of
 * accidentally sharing drafts with personal mode or another unresolved user.
 */
export function getEnterpriseComposerDraftScope(
  binding: { orgId: string; userId: string; boundAt: string },
): ComposerDraftScope {
  const fallback = `unresolved-${binding.boundAt}`;
  return `enterprise:${encodeScopePart(binding.orgId, fallback)}:${encodeScopePart(binding.userId, fallback)}`;
}

/** Reserved for the future personal-account login flow. */
export function getAccountComposerDraftScope(userId: string): ComposerDraftScope {
  return `account:${encodeScopePart(userId, 'unresolved')}`;
}

export function getComposerDraftScopeForEnterpriseMode(mode: EnterpriseMode): ComposerDraftScope {
  return mode.kind === 'personal'
    ? LOCAL_COMPOSER_DRAFT_SCOPE
    : getEnterpriseComposerDraftScope(mode.binding);
}

function getConversationDraftSegment(conversationId: string): string {
  return `${CONVERSATION_COMPOSER_DRAFT_PREFIX}${encodeURIComponent(conversationId)}`;
}

function isScopedDraftKey(key: string): boolean {
  return key.startsWith(`${LOCAL_COMPOSER_DRAFT_SCOPE}:`)
    || key.startsWith('enterprise:')
    || key.startsWith('account:');
}

function migrateLegacyDraftKey(key: string): string {
  if (isScopedDraftKey(key)) return key;
  if (key === LEGACY_WELCOME_COMPOSER_DRAFT_KEY) return WELCOME_COMPOSER_DRAFT_KEY;
  if (key.startsWith(CONVERSATION_COMPOSER_DRAFT_PREFIX)) {
    return `${LOCAL_COMPOSER_DRAFT_SCOPE}:${getConversationDraftSegment(key.slice(CONVERSATION_COMPOSER_DRAFT_PREFIX.length))}`;
  }
  return `${LOCAL_COMPOSER_DRAFT_SCOPE}:${key}`;
}

function migrateComposerDraftState(
  persistedState: unknown,
): Pick<ComposerDraftState, 'drafts'> {
  const candidate = persistedState as Partial<ComposerDraftState> | null;
  const source = candidate?.drafts && typeof candidate.drafts === 'object'
    ? candidate.drafts
    : {};
  const drafts: Record<string, PersistedComposerDraft> = {};

  for (const [legacyKey, draft] of Object.entries(source)) {
    if (!draft || typeof draft.text !== 'string' || typeof draft.updatedAt !== 'number') continue;
    const key = migrateLegacyDraftKey(legacyKey);
    const existing = drafts[key];
    if (!existing || existing.updatedAt < draft.updatedAt) drafts[key] = draft;
  }

  return { drafts: pruneOldest(drafts) };
}

export const useComposerDraftStore = create<ComposerDraftState>()(
  persist(
    (set) => ({
      drafts: {},

      setText: (key, text) => {
        set((state) => {
          const drafts = { ...state.drafts };
          if (text.length === 0 || text.length > MAX_PERSISTED_TEXT_LENGTH) {
            delete drafts[key];
          } else {
            drafts[key] = { text, updatedAt: Date.now() };
          }
          return { drafts: pruneOldest(drafts) };
        });
      },

      clear: (key) => {
        set((state) => {
          if (!(key in state.drafts)) return state;
          const drafts = { ...state.drafts };
          delete drafts[key];
          return { drafts };
        });
      },

      clearAll: () => set({ drafts: {} }),
    }),
    {
      name: 'abu-composer-drafts',
      version: 2,
      migrate: (persistedState) => migrateComposerDraftState(persistedState),
      partialize: (state) => ({ drafts: state.drafts }),
    },
  ),
);

export function getComposerDraftKey(
  conversationId: string | null | undefined,
  scope: ComposerDraftScope = LOCAL_COMPOSER_DRAFT_SCOPE,
): string {
  return conversationId
    ? `${scope}:${getConversationDraftSegment(conversationId)}`
    : `${scope}:${WELCOME_COMPOSER_DRAFT_SEGMENT}`;
}

/** Restore the rich in-session draft, falling back to persisted text. */
export function readComposerDraft(key: string): ComposerDraft {
  if (discardedDraftKeys.has(key)) return emptyDraft();
  const sessionDraft = sessionDrafts.get(key);
  if (sessionDraft) return cloneDraft(sessionDraft);
  return emptyDraft(useComposerDraftStore.getState().drafts[key]?.text ?? '');
}

/** Save rich state in memory and plain text on disk immediately. */
export function writeComposerDraft(key: string, draft: ComposerDraft): void {
  if (discardedDraftKeys.has(key)) return;
  if (hasSessionContent(draft)) sessionDrafts.set(key, cloneDraft(draft));
  else sessionDrafts.delete(key);
  useComposerDraftStore.getState().setText(key, draft.text);
}

/** Debounced callers use this to update only the persistent text layer. */
export function writePersistedComposerText(key: string, text: string): void {
  if (discardedDraftKeys.has(key)) return;
  useComposerDraftStore.getState().setText(key, text);
}

export function clearComposerDraft(key: string): void {
  sessionDrafts.delete(key);
  useComposerDraftStore.getState().clear(key);
}

export function clearConversationComposerDraft(
  conversationId: string,
  scope: ComposerDraftScope = LOCAL_COMPOSER_DRAFT_SCOPE,
): void {
  const segment = getConversationDraftSegment(conversationId);
  const legacyKey = `${CONVERSATION_COMPOSER_DRAFT_PREFIX}${conversationId}`;
  const keys = new Set<string>([getComposerDraftKey(conversationId, scope), legacyKey]);
  const matchesConversation = (key: string) => key === legacyKey || key.endsWith(`:${segment}`);

  for (const key of sessionDrafts.keys()) {
    if (matchesConversation(key)) keys.add(key);
  }
  for (const key of Object.keys(useComposerDraftStore.getState().drafts)) {
    if (matchesConversation(key)) keys.add(key);
  }
  for (const key of keys) {
    discardedDraftKeys.add(key);
    clearComposerDraft(key);
  }
}

export function clearSessionComposerDrafts(): void {
  sessionDrafts.clear();
}

/** Primarily useful for logout/reset flows and isolated tests. */
export function clearAllComposerDrafts(): void {
  clearSessionComposerDrafts();
  discardedDraftKeys.clear();
  useComposerDraftStore.getState().clearAll();
}
