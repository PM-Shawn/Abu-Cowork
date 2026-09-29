import {
  ArrowLeft, Check, CheckSquare, ChevronDown, ChevronRight, ChevronsUpDown, CircleCheck, CircleX, Copy, Download,
  Ellipsis, ExternalLink, Folder, FolderInput, Globe, Inbox, Info, ListTree, LoaderCircle, Minus, PanelLeft,
  PanelRight, Paperclip, Pencil, Plus, Puzzle, Redo2, RefreshCw, Search, Settings, Share, SquarePen, Trash2,
  TriangleAlert, Undo2, UsersRound, Workflow, X, type LucideIcon,
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
  back: ArrowLeft,
  import: FolderInput,
  remove: Minus,
  fileTree: ListTree,
  // Sidebar destinations
  team: UsersRound,
  extensions: Puzzle,
  automation: Workflow,
  todos: CheckSquare,
  inbox: Inbox,
  webPage: Globe,
} as const satisfies Record<string, LucideIcon>;

export type AppIconName = keyof typeof AppIcons;
