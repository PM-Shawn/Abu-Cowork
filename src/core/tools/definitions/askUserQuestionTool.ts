/**
 * ask_user_question — 在对话中弹出结构化选项卡片，阻塞 agent 等用户作答。
 *
 * 对标 Claude Code 的 AskUserQuestion 工具。
 * - 阻塞式：await requestUserQuestion(...)，isConcurrencySafe: false
 * - 每题自动追加「其他…」自由文本出口（UI 层追加，工具不需感知）
 * - 非法 input throw Error → is_error → 模型自行重试
 */
import type { ToolDefinition, UserQuestionPayload } from '../../../types';
import { TOOL_NAMES } from '../toolNames';
import { requestUserQuestion } from '../../agent/permissionBridge';

export const askUserQuestionTool: ToolDefinition = {
  name: TOOL_NAMES.ASK_USER_QUESTION,
  description:
    '向用户弹出结构化选择卡片，等用户作答后继续。' +
    '\n\n**何时使用**：' +
    '\n- 存在多条等效路径，需要用户偏好才能决定' +
    '\n- 无法从上下文推断的关键决策（如输出格式、部署目标）' +
    '\n- 需要暴露隐含假设让用户确认' +
    '\n\n**何时不用**：' +
    '\n- 有合理默认值可用时（直接选默认，不打扰用户）' +
    '\n- 是/否类简单确认（用 confirm 语气直接提问即可）' +
    '\n- 危险操作（走权限确认机制，不用本工具）' +
    '\n\n约束：1-4 题；每题 2-4 选项；header ≤12 字符。' +
    '每个问题自动追加「其他…」自由文本出口，用户可填写不在选项中的答案。',
  inputSchema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        description:
          '问题列表（1-4 题）。每题包含 header（≤12 字符短标签）、question（完整问题文本）、' +
          'multiSelect（true=多选 / false=单选）、options（2-4 个选项，每个有 label 和可选 description）。',
        items: {
          type: 'object',
          properties: {
            header: {
              type: 'string',
              description: '≤12 字符的短标签，用于标识题目，如 "格式"、"部署目标"',
            },
            question: {
              type: 'string',
              description: '完整的问题文本，清晰描述用户需要做的选择',
            },
            multiSelect: {
              type: 'boolean',
              description: 'true = 多选（可选多项）；false = 单选',
            },
            options: {
              type: 'array',
              description: '2-4 个选项',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string', description: '选项标签' },
                  description: { type: 'string', description: '可选的补充说明' },
                },
                required: ['label'],
              },
            },
          },
          required: ['header', 'question', 'multiSelect', 'options'],
        },
      },
    },
    required: ['questions'],
  },
  execute: async (input, context) => {
    const questions = input.questions as unknown[];

    // ── Validate input ──────────────────────────────────────────────────
    if (!Array.isArray(questions) || questions.length < 1 || questions.length > 4) {
      throw new Error(
        `参数错误：questions 数组长度必须在 1-4 之间，收到 ${Array.isArray(questions) ? questions.length : typeof questions}。`,
      );
    }

    for (let i = 0; i < questions.length; i++) {
      const q = questions[i] as Record<string, unknown>;
      const idx = i + 1;

      if (typeof q.header !== 'string' || q.header.trim() === '') {
        throw new Error(`参数错误：第 ${idx} 题 header 不能为空字符串。`);
      }
      if (q.header.length > 12) {
        throw new Error(
          `参数错误：第 ${idx} 题 header "${q.header}" 超过 12 字符（当前 ${q.header.length} 字符）。`,
        );
      }
      if (typeof q.question !== 'string' || q.question.trim() === '') {
        throw new Error(`参数错误：第 ${idx} 题 question 不能为空字符串。`);
      }
      if (typeof q.multiSelect !== 'boolean') {
        throw new Error(`参数错误：第 ${idx} 题 multiSelect 必须是 boolean，收到 ${typeof q.multiSelect}。`);
      }
      const opts = q.options as unknown[];
      if (!Array.isArray(opts) || opts.length < 2 || opts.length > 4) {
        throw new Error(
          `参数错误：第 ${idx} 题 options 长度必须在 2-4 之间，收到 ${Array.isArray(opts) ? opts.length : typeof opts}。`,
        );
      }
      for (let j = 0; j < opts.length; j++) {
        const opt = opts[j] as Record<string, unknown>;
        if (typeof opt.label !== 'string' || opt.label.trim() === '') {
          throw new Error(`参数错误：第 ${idx} 题 options[${j}].label 不能为空。`);
        }
      }
    }

    // ── Suspend until user answers ───────────────────────────────────────
    const toolCallId = context?.toolCallId;
    const conversationId = context?.conversationId ?? '';

    if (!toolCallId) {
      // Defensive: toolExecutor always injects this. If absent, surface as
      // an error so the model is told why, rather than hanging forever.
      throw new Error('内部错误：toolCallId 未注入，无法挂起等待用户作答。');
    }

    const payload: UserQuestionPayload = {
      questions: (questions as Array<Record<string, unknown>>).map((q) => ({
        header: q.header as string,
        question: q.question as string,
        multiSelect: q.multiSelect as boolean,
        options: (q.options as Array<Record<string, unknown>>).map((o) => ({
          label: o.label as string,
          description: typeof o.description === 'string' ? o.description : undefined,
        })),
      })),
    };

    const result = await requestUserQuestion(toolCallId, conversationId, payload);

    // ── Format result ────────────────────────────────────────────────────
    if (result === null) {
      return '用户未作答（已取消或超时）。请基于已知信息继续，或用更明确的方式再次询问。';
    }

    const lines: string[] = ['用户已作答：'];
    result.answers.forEach((ans, i) => {
      lines.push(`${i + 1}. [${ans.header}] ${ans.question}`);
      lines.push(`   → ${ans.selected.join('、')}`);
    });
    return lines.join('\n');
  },
  isConcurrencySafe: false,
};
