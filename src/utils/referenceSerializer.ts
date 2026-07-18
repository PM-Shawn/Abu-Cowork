import type { ChatReference } from '@/types/chatReference';

/** 把选中正文渲成 markdown blockquote（每行前缀 "> "） */
function toBlockquote(text: string): string {
  return text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

/** 代码围栏内容含 ``` 时升级为 ````，避免围栏被正文提前截断 */
function codeFence(text: string): string {
  return text.includes('```') ? '````' : '```';
}

function serializeDocSelection(ref: ChatReference, index: number): string {
  const header = `[引用 ${index} · 来源：${ref.source.name}]`;
  const body = toBlockquote(ref.selection.text);
  const instruction = ref.comment?.trim() ? `\n指令：${ref.comment.trim()}` : '';
  return `${header}\n${body}${instruction}`;
}

function serializeDomElement(ref: ChatReference, index: number): string {
  const header = `[引用 ${index} · 网页元素 ${ref.source.name} · 来源：${ref.source.path}]`;
  const fence = codeFence(ref.selection.text);
  const body = `${fence}html\n${ref.selection.text}\n${fence}`;
  const style =
    ref.selection.style && Object.keys(ref.selection.style).length > 0
      ? `\n关键样式：${Object.entries(ref.selection.style)
          .map(([k, v]) => `${k}: ${v}`)
          .join('; ')}`
      : '';
  const instruction = ref.comment?.trim() ? `\n指令：${ref.comment.trim()}` : '';
  return `${header}\n${body}${style}${instruction}`;
}

/**
 * V1 序列化(方式 A)：把引用片段拼成一段文本前缀，串进 user message。
 * 多片段带序号、各自携带 `指令：` 行 —— 让模型区分「哪段 + 各自指令」。
 * P1 将改为结构化 references 进 AgentLoopOptions；调用点只依赖本函数签名。
 */
export function serializeReferences(refs: ChatReference[]): string {
  if (refs.length === 0) return '';
  return refs
    .map((ref, i) => (ref.kind === 'dom-element' ? serializeDomElement(ref, i + 1) : serializeDocSelection(ref, i + 1)))
    .join('\n\n');
}
