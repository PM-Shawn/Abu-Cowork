import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ExtensionSource } from '@/components/toolbox/extensionSource';

/** Every tab that shows a 市场 | 我的 sub-nav. Experts and teams live on the
 *  专家 page, the other three on 扩展; the store does not care which. */
export type SourceTab = 'plugins' | 'skills' | 'mcp' | 'members' | 'teams';

interface ExtensionSourceState {
  sources: Record<SourceTab, ExtensionSource>;
  setSource: (tab: SourceTab, source: ExtensionSource) => void;
}

export const DEFAULT_SOURCES: Record<SourceTab, ExtensionSource> = {
  plugins: 'market', skills: 'market', mcp: 'market', members: 'market', teams: 'market',
};

/** 市场 is the default on every tab (the shelf is what a fresh install has);
 *  each tab remembers the user's last pick across restarts. */
export const useExtensionSourceStore = create<ExtensionSourceState>()(
  persist(
    (set) => ({
      sources: { ...DEFAULT_SOURCES },
      setSource: (tab, source) => set((s) => ({ sources: { ...s.sources, [tab]: source } })),
    }),
    { name: 'abu-extension-source', version: 1, partialize: (s) => ({ sources: s.sources }) },
  ),
);
