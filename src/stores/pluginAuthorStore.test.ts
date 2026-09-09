import { beforeEach, expect, it, vi } from 'vitest';
import { planPreparedInstall, releasePreparedInstall } from '@/core/plugin/installer';
import { usePluginAuthorStore } from './pluginAuthorStore';
import { validatePluginAuthor, preparePluginAuthor, bindPluginAuthor, createPluginAuthor, listPluginAuthors } from '@/core/plugin/authorBridge';
vi.mock('@/core/plugin/authorBridge', () => ({ bindPluginAuthor: vi.fn(), createPluginAuthor: vi.fn(), listPluginAuthors: vi.fn(), preparePluginAuthor: vi.fn(), validatePluginAuthor: vi.fn() }));
vi.mock('@/core/plugin/installer', () => ({ planPreparedInstall: vi.fn(), releasePreparedInstall: vi.fn() }));
vi.mock('./chatStore', () => ({ useChatStore: { getState: () => chat } }));
vi.mock('./settingsStore', () => ({ useSettingsStore: { getState: () => ({ closeExtensions: vi.fn() }) } }));
const chat = vi.hoisted(() => ({ conversations: {} as Record<string, unknown>, conversationIndex: {} as Record<string, unknown>,
  switchConversation: vi.fn(), createConversation: vi.fn(() => 'new-conversation'), renameConversation: vi.fn(), setPendingInput: vi.fn() }));
const author = { id: 'a'.repeat(32), createdAt: '2026-09-09', conversationId: 'existing', name: 'demo', prepared: null, sourceDir: '/home/Abu Plugins/a', marketplace: 'author-a', key: 'demo@author-a' };
beforeEach(() => { vi.clearAllMocks(); chat.conversations = {}; chat.conversationIndex = {}; vi.mocked(listPluginAuthors).mockResolvedValue([author]); });
it('reopens an indexed conversation even when its messages were unloaded', async () => {
  chat.conversationIndex.existing = { id: 'existing' };
  await usePluginAuthorStore.getState().edit(author);
  expect(chat.switchConversation).toHaveBeenCalledWith('existing');
  expect(chat.createConversation).not.toHaveBeenCalled();
  expect(bindPluginAuthor).not.toHaveBeenCalled();
});
it('replaces a deleted conversation using the expected old binding', async () => {
  await usePluginAuthorStore.getState().edit(author);
  expect(bindPluginAuthor).toHaveBeenCalledWith(author.id, 'new-conversation', 'existing');
  expect(chat.createConversation).toHaveBeenCalledWith(author.sourceDir);
});
it('persists the draft before starting its creation conversation', async () => {
  vi.mocked(createPluginAuthor).mockResolvedValue({ ...author, conversationId: null, name: null, key: null });
  await usePluginAuthorStore.getState().create();
  expect(createPluginAuthor).toHaveBeenCalledWith();
  expect(listPluginAuthors).toHaveBeenCalledTimes(2);
  const prompt = chat.setPendingInput.mock.calls[0][0];
  expect(prompt).toMatch(/^\/abu-plugin-builder /);
  expect(prompt.length).toBeLessThan(80);
  expect(prompt).not.toContain('plugin_prepare');
});

it('does not mark a draft validated when component parsing fails', async () => {
  vi.mocked(preparePluginAuthor).mockResolvedValue({ author, snapshot: { token: 'invalid' } } as never);
  vi.mocked(planPreparedInstall).mockRejectedValue(new Error('Invalid connector'));
  vi.mocked(releasePreparedInstall).mockResolvedValue(undefined);
  await expect(usePluginAuthorStore.getState().prepare({ id: author.id })).rejects.toThrow('Invalid connector');
  expect(validatePluginAuthor).not.toHaveBeenCalled();
  expect(releasePreparedInstall).toHaveBeenCalledWith('invalid');
});
