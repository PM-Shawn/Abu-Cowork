import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComposerDraft } from './composerDraftStore';
import type { EnterpriseBinding } from '@/core/enterprise/types';
import {
  clearAllComposerDrafts,
  clearComposerDraft,
  clearConversationComposerDraft,
  clearSessionComposerDrafts,
  getAccountComposerDraftScope,
  getComposerDraftKey,
  getComposerDraftScopeForEnterpriseMode,
  getEnterpriseComposerDraftScope,
  LOCAL_COMPOSER_DRAFT_SCOPE,
  readComposerDraft,
  useComposerDraftStore,
  WELCOME_COMPOSER_DRAFT_KEY,
  writeComposerDraft,
  writePersistedComposerText,
} from './composerDraftStore';

function draft(text: string, overrides: Partial<ComposerDraft> = {}): ComposerDraft {
  return {
    text,
    images: [],
    files: [],
    references: [],
    selectedSkill: null,
    selectedAgent: null,
    ...overrides,
  };
}

function enterpriseBinding(overrides: Partial<EnterpriseBinding> = {}): EnterpriseBinding {
  return {
    serverUrl: 'https://example.test',
    orgId: 'org',
    orgName: 'Example',
    userId: 'user',
    userName: 'User',
    userEmail: 'user@example.test',
    deptId: null,
    roleId: null,
    accessToken: 'test-token',
    boundAt: '2026-08-04T00:00:00.000Z',
    llmEndpoint: null,
    llmVirtualKey: null,
    llmKeyExpiresAt: null,
    ...overrides,
  };
}

describe('composerDraftStore', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    clearAllComposerDrafts();
  });

  it('uses a stable welcome key and distinct per-conversation keys', () => {
    expect(getComposerDraftKey(null)).toBe(WELCOME_COMPOSER_DRAFT_KEY);
    expect(getComposerDraftKey('a')).toBe('local:conversation:a');
    expect(getComposerDraftKey('b')).toBe('local:conversation:b');
  });

  it('isolates local, enterprise, and future personal-account drafts', () => {
    const enterpriseA = getEnterpriseComposerDraftScope({ orgId: 'org', userId: 'alice', boundAt: 't1' });
    const enterpriseB = getEnterpriseComposerDraftScope({ orgId: 'org', userId: 'bob', boundAt: 't2' });
    const account = getAccountComposerDraftScope('alice@example.com');

    expect(getComposerDraftKey(null, LOCAL_COMPOSER_DRAFT_SCOPE)).toBe('local:welcome');
    expect(getComposerDraftKey(null, enterpriseA)).toBe('enterprise:org:alice:welcome');
    expect(getComposerDraftKey(null, enterpriseB)).toBe('enterprise:org:bob:welcome');
    expect(getComposerDraftKey(null, account)).toBe('account:alice%40example.com:welcome');
    expect(new Set([
      getComposerDraftKey('same-conversation', LOCAL_COMPOSER_DRAFT_SCOPE),
      getComposerDraftKey('same-conversation', enterpriseA),
      getComposerDraftKey('same-conversation', enterpriseB),
      getComposerDraftKey('same-conversation', account),
    ])).toHaveLength(4);
  });

  it('derives a stable scope from the current personal or enterprise mode', () => {
    expect(getComposerDraftScopeForEnterpriseMode({ kind: 'personal' })).toBe('local');
    expect(getComposerDraftScopeForEnterpriseMode({
      kind: 'enterprise',
      binding: enterpriseBinding({ orgId: 'org/a', userId: 'user:b' }),
      config: null,
    })).toBe('enterprise:org%2Fa:user%3Ab');
  });

  it('migrates legacy unscoped drafts into local scope without overwriting newer scoped text', async () => {
    localStorage.setItem('abu-composer-drafts', JSON.stringify({
      version: 1,
      state: {
        drafts: {
          welcome: { text: 'old welcome', updatedAt: 1 },
          'conversation:a': { text: 'old A', updatedAt: 2 },
          'local:conversation:a': { text: 'new A', updatedAt: 3 },
        },
      },
    }));

    await useComposerDraftStore.persist.rehydrate();

    expect(useComposerDraftStore.getState().drafts).toEqual({
      'local:welcome': { text: 'old welcome', updatedAt: 1 },
      'local:conversation:a': { text: 'new A', updatedAt: 3 },
    });
  });

  it('restores independent drafts after switching A → B → A', () => {
    const a = getComposerDraftKey('a');
    const b = getComposerDraftKey('b');
    writeComposerDraft(a, draft('draft A'));
    writeComposerDraft(b, draft('draft B'));

    expect(readComposerDraft(a).text).toBe('draft A');
    expect(readComposerDraft(b).text).toBe('draft B');
  });

  it('restores persisted text after the rich session cache is reset', () => {
    const key = getComposerDraftKey('reload-me');
    writeComposerDraft(key, draft('survives reload'));

    clearSessionComposerDrafts();

    expect(readComposerDraft(key)).toEqual(draft('survives reload'));
  });

  it('keeps rich content in memory without persisting image bytes or file paths', () => {
    const key = getComposerDraftKey('private-rich-draft');
    writeComposerDraft(key, draft('safe text', {
      images: [{ id: 'image-1', data: 'private-image-base64', mediaType: 'image/png' }],
      files: [{ id: 'file-1', name: 'secret.pdf', path: '/private/secret.pdf' }],
    }));

    const stored = localStorage.getItem('abu-composer-drafts') ?? '';
    expect(stored).toContain('safe text');
    expect(stored).not.toContain('private-image-base64');
    expect(stored).not.toContain('/private/secret.pdf');
    expect(readComposerDraft(key).images).toHaveLength(1);
    expect(readComposerDraft(key).files).toHaveLength(1);
  });

  it('removes empty drafts and clears both storage layers explicitly', () => {
    const key = getComposerDraftKey('clear-me');
    writeComposerDraft(key, draft('temporary'));
    clearComposerDraft(key);

    expect(readComposerDraft(key)).toEqual(draft(''));
    expect(useComposerDraftStore.getState().drafts[key]).toBeUndefined();
  });

  it('does not resurrect a deleted conversation draft from a stale UI flush', () => {
    const conversationId = 'deleted';
    const key = getComposerDraftKey(conversationId);
    writeComposerDraft(key, draft('before delete'));

    clearConversationComposerDraft(conversationId);
    writeComposerDraft(key, draft('late component cleanup'));
    writePersistedComposerText(key, 'late debounce');

    expect(readComposerDraft(key)).toEqual(draft(''));
    expect(useComposerDraftStore.getState().drafts[key]).toBeUndefined();
  });

  it('clears a deleted conversation draft from every known account scope', () => {
    const conversationId = 'shared-id';
    const enterpriseA = getEnterpriseComposerDraftScope({ orgId: 'org', userId: 'alice', boundAt: 't1' });
    const enterpriseB = getEnterpriseComposerDraftScope({ orgId: 'org', userId: 'bob', boundAt: 't2' });
    const keys = [
      getComposerDraftKey(conversationId),
      getComposerDraftKey(conversationId, enterpriseA),
      getComposerDraftKey(conversationId, enterpriseB),
    ];
    keys.forEach((key, index) => writeComposerDraft(key, draft(`draft ${index}`)));

    clearConversationComposerDraft(conversationId, enterpriseA);

    keys.forEach((key) => {
      expect(readComposerDraft(key)).toEqual(draft(''));
      expect(useComposerDraftStore.getState().drafts[key]).toBeUndefined();
    });
  });

  it('does not persist an oversized prompt but retains it for the current session', () => {
    const key = getComposerDraftKey('oversized');
    const oversized = 'x'.repeat(100_001);
    writeComposerDraft(key, draft(oversized));

    expect(readComposerDraft(key).text).toBe(oversized);
    expect(useComposerDraftStore.getState().drafts[key]).toBeUndefined();

    clearSessionComposerDrafts();
    expect(readComposerDraft(key).text).toBe('');
  });

  it('prunes the oldest persisted drafts after the 100-entry limit', () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now++);
    for (let i = 0; i < 101; i += 1) {
      writePersistedComposerText(getComposerDraftKey(String(i)), `draft ${i}`);
    }

    const drafts = useComposerDraftStore.getState().drafts;
    expect(Object.keys(drafts)).toHaveLength(100);
    expect(drafts['local:conversation:0']).toBeUndefined();
    expect(drafts['local:conversation:100']?.text).toBe('draft 100');
  });
});
