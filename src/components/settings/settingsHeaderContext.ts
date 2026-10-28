import { createContext } from 'react';

// undefined denotes a standalone section; null denotes a header awaiting its DOM node.
export const SettingsHeaderContext = createContext<HTMLElement | null | undefined>(undefined);
