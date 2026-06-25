import type { ToolDefinition } from '../../../types';
import { useInboxStore } from '../../../stores/inboxStore';
import { TOOL_NAMES } from '../toolNames';

export const createTodoTool: ToolDefinition = {
  name: TOOL_NAMES.CREATE_TODO,
  description:
    '向用户的收件箱投递一条「待办提议」。当你在对话中识别出用户后续需要做的事，' +
    '或想主动帮用户跟进时调用。工具调用本身不会立刻创建待办——' +
    '用户在收件箱里点「加入待办」后才会真正落入待办列表。' +
    '用 title 字段写一句话总结这件待办，要用用户视角的业务语言，不要提及工具名或内部细节。',
  inputSchema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: '待办的标题。一句话，最多 60 个汉字。例如「整理上周三篇草稿并归档」。',
      },
      reason: {
        type: 'string',
        description: '可选：为什么建议这条待办（一句话即可），会展示给用户帮助判断要不要接受。',
      },
    },
    required: ['title'],
  },
  execute: async (input, ctx) => {
    const title = String(input.title ?? '').trim();
    if (!title) return '标题不能为空，未创建提议。';
    const reasonRaw = input.reason;
    const reason = typeof reasonRaw === 'string' ? reasonRaw.trim() : '';
    const summary = reason ? `${title}（${reason}）` : title;
    useInboxStore.getState().addItem({
      type: 'agent_proposed_todo',
      summary,
      conversationId: ctx?.conversationId,
      payload: { draft: { title } },
    });
    return `已把「${title}」放进用户的收件箱，等待确认。`;
  },
  isConcurrencySafe: true,
};
