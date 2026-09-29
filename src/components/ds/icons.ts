import {
  Check, ChevronDown, ChevronRight, ChevronsUpDown, CircleCheck, CircleX, Copy, Download, Ellipsis,
  ExternalLink, Folder, Info, LoaderCircle, Minus, PanelLeft, PanelRight, Paperclip, Pencil, Plus, Redo2,
  RefreshCw, Search, Settings, Share, SquarePen, Trash2, TriangleAlert, Undo2, X, type LucideIcon,
} from 'lucide-react';

// One icon per standard action across the whole app (Apple HIG "Standard icons").
// Add an entry here before using a new action icon anywhere else.
export const AppIcons = {
  copy: Copy,
  delete: Trash2,
  share: Share,
  more: Ellipsis,
  add: Plus,
  close: X,
  search: Search,
  settings: Settings,
  done: Check,
  rename: Pencil,
  compose: SquarePen,
  folder: Folder,
  attach: Paperclip,
  undo: Undo2,
  redo: Redo2,
  download: Download,
  openExternal: ExternalLink,
  retry: RefreshCw,
  expand: ChevronDown,
  disclose: ChevronRight,
  success: CircleCheck,
  warning: TriangleAlert,
  error: CircleX,
  info: Info,
  loading: LoaderCircle,
  mixed: Minus,
  selectorChevrons: ChevronsUpDown,
  sidebar: PanelLeft,
  rightPanel: PanelRight,
} as const satisfies Record<string, LucideIcon>;

export type AppIconName = keyof typeof AppIcons;
