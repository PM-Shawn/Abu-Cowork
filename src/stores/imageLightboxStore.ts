import { create } from 'zustand';

export type ImageLightboxMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

export interface ImageLightboxItem {
  id: string;
  mediaType: ImageLightboxMediaType;
  data: string;
  filePath?: string;
  conversationId?: string;
  workspacePath?: string | null;
}

interface ImageLightboxState {
  isOpen: boolean;
  items: ImageLightboxItem[];
  activeIndex: number;
  returnFocus: HTMLElement | null;
}

interface ImageLightboxActions {
  open: (items: ImageLightboxItem[], activeIndex: number, returnFocus?: HTMLElement | null) => void;
  close: () => void;
  previous: () => void;
  next: () => void;
}

export type ImageLightboxStore = ImageLightboxState & ImageLightboxActions;

const CLOSED_STATE: ImageLightboxState = {
  isOpen: false,
  items: [],
  activeIndex: 0,
  returnFocus: null,
};

function clampIndex(index: number, itemCount: number): number {
  if (!Number.isFinite(index)) return 0;
  return Math.min(Math.max(Math.trunc(index), 0), Math.max(itemCount - 1, 0));
}

/** Purely ephemeral UI state: image bytes and DOM focus targets must never persist. */
export const useImageLightboxStore = create<ImageLightboxStore>((set) => ({
  ...CLOSED_STATE,

  open: (items, activeIndex, returnFocus = null) => {
    if (items.length === 0) return;
    set({
      isOpen: true,
      items: [...items],
      activeIndex: clampIndex(activeIndex, items.length),
      returnFocus,
    });
  },

  close: () => set(CLOSED_STATE),

  previous: () => set((state) => ({
    activeIndex: Math.max(0, state.activeIndex - 1),
  })),

  next: () => set((state) => ({
    activeIndex: Math.min(Math.max(state.items.length - 1, 0), state.activeIndex + 1),
  })),
}));
