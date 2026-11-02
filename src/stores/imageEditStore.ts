import { create } from 'zustand';
import type { ImageEditDraft, ImageEditTool } from '@/types/media';
import { changeImageLayer, travelImageHistory, type ImageDraftHistory } from '@/core/media/imageDraft';
import { invokeElectronMedia } from '@/utils/electronHost';

export interface ImageEditEntry {
  key: string;
  composerKey: string;
  originalPath: string;
  draft: ImageEditDraft;
  history: ImageDraftHistory;
}

interface ImageEditState {
  entries: Record<string, ImageEditEntry>;
  active: Record<string, string>;
  pending: Record<string, symbol>;
  activate: (entry: ImageEditEntry) => void;
  selectTool: (key: string, tool: ImageEditTool) => void;
  setPrompt: (key: string, prompt: string) => void;
  changeLayer: <K extends 'comments' | 'markup' | 'region'>(key: string, layer: K, items: ImageEditDraft[K]) => void;
  travel: (key: string, direction: 'undo' | 'redo') => void;
  cancel: (composerKey: string) => Promise<void>;
  clear: (composerKey?: string) => Promise<void>;
}

export function findImageEditEntry(state: Pick<ImageEditState, 'entries' | 'active'>, composerKey: string, originalPath: string | undefined, captureId?: string): ImageEditEntry | undefined {
  const matches = (entry: ImageEditEntry | undefined) => entry?.composerKey === composerKey
    && entry.originalPath === originalPath && (!captureId || entry.draft.sourceCaptureId === captureId);
  const active = state.entries[state.active[composerKey]];
  return matches(active) ? active : Object.values(state.entries).find(matches);
}

const release = (entry: ImageEditEntry) => invokeElectronMedia<void>('release-capture', { conversationId: entry.draft.conversationId, fileRef: entry.draft.source.fileRef });

export const useImageEditStore = create<ImageEditState>((set, get) => ({
  entries: {}, active: {}, pending: {},
  activate: entry => set(state => ({ entries: { ...state.entries, [entry.key]: entry }, active: { ...state.active, [entry.composerKey]: entry.key } })),
  selectTool: (key, activeTool) => set(state => {
    const entry = state.entries[key];
    if (!entry) throw new Error('Image draft is unavailable');
    return { entries: { ...state.entries, [key]: { ...entry, draft: { ...entry.draft, activeTool } } } };
  }),
  setPrompt: (key, prompt) => set(state => {
    const entry = state.entries[key];
    if (!entry) throw new Error('Image draft is unavailable');
    return { entries: { ...state.entries, [key]: { ...entry, draft: { ...entry.draft, prompt } } } };
  }),
  changeLayer: (key, layer, items) => set(state => {
    const entry = state.entries[key];
    if (!entry) throw new Error('Image draft is unavailable');
    return { entries: { ...state.entries, [key]: { ...entry, ...changeImageLayer(entry.draft, entry.history, layer, items) } } };
  }),
  travel: (key, direction) => set(state => {
    const entry = state.entries[key];
    if (!entry) throw new Error('Image draft is unavailable');
    return { entries: { ...state.entries, [key]: { ...entry, ...travelImageHistory(entry.draft, entry.history, direction) } } };
  }),
  cancel: async composerKey => {
    const entry = get().entries[get().active[composerKey]];
    set(state => {
    const active = { ...state.active };
    const entries = { ...state.entries };
    const pending = { ...state.pending };
    delete entries[active[composerKey]];
    delete active[composerKey];
    delete pending[composerKey];
    return { active, entries, pending };
    });
    if (entry) await release(entry);
  },
  clear: async composerKey => {
    const entries = Object.values(get().entries).filter(entry => !composerKey || entry.composerKey === composerKey);
    set(state => composerKey ? {
    entries: Object.fromEntries(Object.entries(state.entries).filter(([, entry]) => entry.composerKey !== composerKey)),
    active: Object.fromEntries(Object.entries(state.active).filter(([key]) => key !== composerKey)),
    pending: Object.fromEntries(Object.entries(state.pending).filter(([key]) => key !== composerKey)),
    } : { entries: {}, active: {}, pending: {} });
    await Promise.all(entries.map(release));
  },
}));
