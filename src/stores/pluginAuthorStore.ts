import { create } from 'zustand';
import { homeDir } from '@tauri-apps/api/path';
import { deletePluginAuthor, bindPluginAuthor, validatePluginAuthor, createPluginAuthor, listPluginAuthors, preparePluginAuthor, type PluginAuthor } from '@/core/plugin/authorBridge';
import { planPreparedInstall, releasePreparedInstall, type InstallDisclosure } from '@/core/plugin/installer';
import { useChatStore } from './chatStore';
import { useSettingsStore } from './settingsStore';
import { getI18n, format } from '@/i18n';

interface PluginAuthorState {
  authors: PluginAuthor[];
  creating: boolean;
  remove: (id: string) => Promise<void>;
  error: string | null;
  refresh: () => Promise<void>;
  create: () => Promise<void>;
  edit: (author: PluginAuthor) => Promise<void>;
  prepare: (identity: { id: string } | { conversationId: string }) => Promise<{ author: PluginAuthor; disclosure: InstallDisclosure }>;
}
async function openAuthor(author: PluginAuthor) {
  const chat = useChatStore.getState();
  if (author.conversationId && (chat.conversations[author.conversationId] || chat.conversationIndex[author.conversationId])) {
    await chat.switchConversation(author.conversationId);
  } else {
    const conversationId = chat.createConversation(author.sourceDir);
    await bindPluginAuthor(author.id, conversationId, author.conversationId);
    chat.renameConversation(conversationId, format(getI18n().toolbox.pluginsAuthorConversation, { name: author.name ?? getI18n().toolbox.pluginsDraft }));
    chat.setPendingInput(getI18n().toolbox.pluginsAuthorPrompt);
  }
  useSettingsStore.getState().closeExtensions();
}
export const usePluginAuthorStore = create<PluginAuthorState>((set, get) => ({
  authors: [], error: null, creating: false,
  remove: async id => { await deletePluginAuthor(id); await get().refresh(); },
  refresh: async () => {
    try { set({ authors: await listPluginAuthors(), error: null }); }
    catch (error) { set({ error: String(error) }); throw error; }
  },
  create: async () => {
    if (get().creating) return;
    set({ creating: true });
    try {
    const author = await createPluginAuthor();
    await get().refresh();
    await openAuthor(author);
    await get().refresh();
    } finally { set({ creating: false }); }
  },
  edit: async author => { await openAuthor(author); await get().refresh(); },
  prepare: async identity => {
    const prepared = await preparePluginAuthor(identity);
    try {
      const disclosure = await planPreparedInstall(prepared.snapshot, {
        home: await homeDir(), marketplaceName: prepared.author.marketplace,
        marketplaceDir: prepared.author.sourceDir, entry: { name: prepared.snapshot.name, source: prepared.snapshot.source },
      });
      const author = await validatePluginAuthor(prepared.snapshot.token);
      await get().refresh();
      return { author, disclosure };
    } catch (error) { await releasePreparedInstall(prepared.snapshot.token).catch(() => {}); throw error; }
  },
}));
