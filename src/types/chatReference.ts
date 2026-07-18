export type ReferenceKind = 'doc-selection' | 'dom-element'; // 扩展点(P3): 'code-selection'

export type DocLocator =
  | { type: 'line'; startLine: number; endLine: number }
  | { type: 'page'; startPage: number; endPage: number }
  | { type: 'cell'; cellAddress: string };

export interface ChatReference {
  id: string;
  kind: ReferenceKind;
  source: {
    path: string;
    name: string;
    docType: 'markdown' | 'pdf' | 'text' | 'message' | 'web';
  };
  selection: {
    text: string;
    context?: string;
    locator?: DocLocator;
    /** computedStyle 白名单快照（dom-element 专用） */
    style?: Record<string, string>;
  };
  /** 批注即指令；「添加到对话」时为 undefined */
  comment?: string;
  createdAt: number;
}

/**
 * 元素拾取脚本回传的元素快照（浏览器页签/预览页签共用同一契约，见
 * docs/2026-07-18-browser-element-select-design.md §4 与
 * docs/2026-07-19-preview-element-select-design.md）。
 */
export interface BrowserElementPayload {
  tagName: string;
  id: string;
  classList: string[];
  selector: string;
  /** 已在服务端/脚本侧截断 ≤ 40960 chars */
  outerHTML: string;
  /** 已在服务端/脚本侧截断 ≤ 2000 chars */
  text: string;
  /** ~25 个白名单键的 computed style */
  computedStyle: Record<string, string>;
  rect: { x: number; y: number; width: number; height: number };
  pageUrl: string;
  pageTitle: string;
  comment?: string;
}

/** ID gen — 与 store 约定同款(CLAUDE.md §5) */
export function newReferenceId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

export function createDocReference(params: {
  path: string;
  name: string;
  docType: ChatReference['source']['docType'];
  text: string;
  context?: string;
  locator?: DocLocator;
  comment?: string;
}): ChatReference {
  return {
    id: newReferenceId(),
    kind: 'doc-selection',
    source: { path: params.path, name: params.name, docType: params.docType },
    selection: { text: params.text, context: params.context, locator: params.locator },
    comment: params.comment,
    createdAt: Date.now(),
  };
}

/** `tag#id.cls1.cls2`（tag 小写，缺失的 id/class 跳过），截断 60 字符（超出加省略号）。 */
export function domElementDisplayName(payload: Pick<BrowserElementPayload, 'tagName' | 'id' | 'classList'>): string {
  const tag = payload.tagName.toLowerCase();
  const idPart = payload.id ? `#${payload.id}` : '';
  const classPart = payload.classList.length > 0 ? `.${payload.classList.join('.')}` : '';
  const name = `${tag}${idPart}${classPart}`;
  return name.length > 60 ? `${name.slice(0, 60)}…` : name;
}

export function createDomElementReference(payload: BrowserElementPayload): ChatReference {
  return {
    id: newReferenceId(),
    kind: 'dom-element',
    source: {
      path: payload.pageUrl,
      name: domElementDisplayName(payload),
      docType: 'web',
    },
    selection: {
      text: payload.outerHTML,
      context: payload.text,
      style: payload.computedStyle,
    },
    comment: payload.comment,
    createdAt: Date.now(),
  };
}
