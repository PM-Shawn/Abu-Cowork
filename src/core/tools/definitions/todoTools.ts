import type { ToolDefinition } from '../../../types';
import { useInboxStore } from '../../../stores/inboxStore';
import { TOOL_NAMES } from '../toolNames';

export const createTodoTool: ToolDefinition = {
  name: TOOL_NAMES.CREATE_TODO,
  description:
    'Submit a "to-do proposal" to the user\'s inbox. Call this when you identify something the user will need to do later in the conversation, or when you want to proactively help the user follow up. The tool call itself does not create the to-do immediately — it only becomes a real to-do item after the user clicks "Add to To-do" in their inbox. Use the title field to summarize the to-do in one sentence, using business language from the user\'s perspective, without mentioning tool names or internal details.',
  inputSchema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'To-do title. One sentence, concise. Example: "Organize last week\'s three drafts and archive them".',
      },
      reason: {
        type: 'string',
        description: 'Optional: why this to-do is suggested (one sentence), shown to the user to help them decide whether to accept it.',
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
