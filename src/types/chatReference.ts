export type ReferenceKind = 'doc-selection'; // 扩展点(P2): 'code-selection' | 'dom-element'

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
    docType: 'markdown' | 'pdf' | 'text' | 'message';
  };
  selection: {
    text: string;
    context?: string;
    locator?: DocLocator;
  };
  /** 批注即指令；「添加到对话」时为 undefined */
  comment?: string;
  createdAt: number;
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
