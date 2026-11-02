import { isRunByDefault } from '@/utils/runByDefault';
import { isVideoFile } from '@/core/media/mediaTypes';

export type RendererType = 'markdown' | 'code' | 'image' | 'video' | 'text' | 'html' | 'pdf' | 'docx' | 'pptx' | 'xlsx' | 'csv' | 'unsupported';

/** Workbook formats the spreadsheet preview reads. */
export const SPREADSHEET_EXTENSIONS = ['xlsx', 'xls', 'xlsm', 'xlsb', 'ods', 'fods'];

/** How the preview shows a file, from its name. */
export function getRendererType(filePath: string): RendererType {
  if (filePath.startsWith('data:image/')) return 'image';
  if (isVideoFile(filePath)) return 'video';
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  if (ext === 'md') return 'markdown';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'docx') return 'docx';
  if (ext === 'pptx' || ext === 'ppt') return 'pptx';
  if (SPREADSHEET_EXTENSIONS.includes(ext)) return 'xlsx';
  if (ext === 'csv' || ext === 'tsv') return 'csv';
  if ([
    'ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'go', 'java', 'cpp', 'c', 'h',
    'json', 'yaml', 'yml', 'toml', 'xml', 'css', 'scss', 'less',
    'sh', 'bash', 'zsh', 'sql', 'graphql', 'rb', 'php', 'swift', 'kt'
  ].includes(ext)) return 'code';
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp'].includes(ext)) return 'image';
  if (['txt', 'log'].includes(ext)) return 'text';
  return 'unsupported';
}

export interface PreviewToolbarButtons {
  /** 源码/预览切换（只有能同时渲染+看源码的类型） */
  viewToggle: boolean;
  /** 全屏 */
  fullscreen: boolean;
  /** 用系统默认应用打开 */
  openInApp: boolean;
  /** 版本历史（可编辑类型） */
  versionHistory: boolean;
}

const VIEW_TOGGLE = new Set<RendererType>(['html', 'markdown']);
const EDITABLE = new Set<RendererType>(['code', 'text', 'html', 'markdown']);

/**
 * Whether the preview offers to open the file in its default application. A file the system
 * would run is only shown in the file manager, previewed or not. An image held as a data URL
 * has no name to read.
 */
export function offersOpenInApp(type: RendererType, filePath: string): boolean {
  if (filePath.startsWith('data:')) return type !== 'unsupported';
  return !isRunByDefault(filePath);
}

/** Whether a file of this name has a version history: the four types the preview edits. */
export function hasVersionHistory(filePath: string): boolean {
  return EDITABLE.has(getRendererType(filePath));
}

/** 声明式：每种渲染类型显示哪些工具栏按钮。加新格式只改这里。 */
export function getToolbarButtons(
  type: RendererType,
  filePath: string,
  options: { readOnly?: boolean } = {},
): PreviewToolbarButtons {
  const supported = type !== 'unsupported';
  return {
    viewToggle: VIEW_TOGGLE.has(type),
    fullscreen: supported,
    openInApp: offersOpenInApp(type, filePath),
    // Reverting to a version writes the file, so a read-only preview has no history.
    versionHistory: EDITABLE.has(type) && !options.readOnly,
  };
}
