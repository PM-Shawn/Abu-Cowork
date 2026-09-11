import type { PluginSnapshot } from './snapshotBridge';

export interface PluginAuthor {
  id: string;
  createdAt: string;
  conversationId: string | null;
  name: string | null;
  sourceDir: string;
  marketplace: string;
  key: string | null;
  prepared: { version: string; checksum: string; description: string } | null;
}
export interface PreparedAuthor {
  author: PluginAuthor;
  snapshot: PluginSnapshot & { name: string; description: string; authoringId: string };
}
async function request<T>(action: string, input: object = {}): Promise<T> {
  const bridge = (globalThis as typeof globalThis & { __ABU_SHELL__?: {
    pluginAuthor?: (action: string, input: object) => Promise<unknown>;
  } }).__ABU_SHELL__?.pluginAuthor;
  if (!bridge) throw new Error('Plugin authoring requires the Electron desktop host');
  return await bridge(action, input) as T;
}
export const listPluginAuthors = () => request<PluginAuthor[]>('list');
export const createPluginAuthor = () => request<PluginAuthor>('create');
export const bindPluginAuthor = (id: string, conversationId: string, expectedConversationId: string | null = null) => request<PluginAuthor>('bind', { id, conversationId, expectedConversationId });
export const preparePluginAuthor = (identity: { id: string } | { conversationId: string }) => request<PreparedAuthor>('prepare', identity);

export const validatePluginAuthor = (token: string) => request<PluginAuthor>('validated', { token });

export const deletePluginAuthor = (id: string) => request<PluginAuthor>('delete', { id });
