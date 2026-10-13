import { isRunByDefault } from '@/utils/runByDefault';
import type { RendererType } from './PreviewPanel';

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
