import type { ChatReference } from '@/types/chatReference';

/** 把选中正文渲成 markdown blockquote（每行前缀 "> "） */
function toBlockquote(text: string): string {
  return text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

/**
 * V1 序列化(方式 A)：把引用片段拼成一段文本前缀，串进 user message。
 * 多片段带序号、各自携带 `指令：` 行 —— 让模型区分「哪段 + 各自指令」。
 * P1 将改为结构化 references 进 AgentLoopOptions；调用点只依赖本函数签名。
 */
export function serializeReferences(refs: ChatReference[]): string {
  if (refs.length === 0) return '';
  return refs
    .map((ref, i) => {
      const header = `[引用 ${i + 1} · 来源：${ref.source.name}]`;
      const body = toBlockquote(ref.selection.text);
      const instruction = ref.comment?.trim() ? `\n指令：${ref.comment.trim()}` : '';
      return `${header}\n${body}${instruction}`;
    })
    .join('\n\n');
}
