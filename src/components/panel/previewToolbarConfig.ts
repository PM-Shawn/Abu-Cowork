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
 * Whether the preview offers to open the file in its default application. A file with no
 * preview that the system would run is only shown in the file manager.
 */
export function offersOpenInApp(type: RendererType, filePath: string): boolean {
  return type !== 'unsupported' || !isRunByDefault(filePath);
}

/** 声明式：每种渲染类型显示哪些工具栏按钮。加新格式只改这里。 */
export function getToolbarButtons(type: RendererType, filePath: string): PreviewToolbarButtons {
  const supported = type !== 'unsupported';
  return {
    viewToggle: VIEW_TOGGLE.has(type),
    fullscreen: supported,
    openInApp: offersOpenInApp(type, filePath),
    versionHistory: EDITABLE.has(type),
  };
}
