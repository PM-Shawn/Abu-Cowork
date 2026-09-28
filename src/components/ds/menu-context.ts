import { createContext, useContext } from 'react';

export type MenuKind = 'dropdown' | 'context';

export const MenuKindContext = createContext<MenuKind | null>(null);

export function useMenuKind(): MenuKind {
  const kind = useContext(MenuKindContext);
  if (!kind) throw new Error('MenuItem, MenuSeparator and MenuLabel must render inside <Menu> or <ContextMenu>.');
  return kind;
}
