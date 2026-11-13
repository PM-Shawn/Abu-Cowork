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
import { getI18n, format } from '../../../i18n';

export const askUserQuestionTool: ToolDefinition = {
  name: TOOL_NAMES.ASK_USER_QUESTION,
  description:
    'Show the user a structured choice card and wait for their answer before continuing.' +
    '\n\n**When to use**:' +
    '\n- A wrong guess would be costly (sending, deleting, overwriting, spending, committing the user to a figure or a date, or redoing most of the work) and the answer is not in the files, memory, the conversation or a quick search' +
    '\n\n**When NOT to use**:' +
    '\n- The answer can be found with tools (look it up instead)' +
    '\n- A wrong guess is cheap to fix (take the most likely option and state the assumption in your reply)' +
    '\n- Something already answered in this conversation, or what the user already asked you to do (do not ask permission for it)' +
    '\n- Asking whether to continue partway through a task' +
    '\n- Dangerous operations (use the permission confirmation mechanism, not this tool)' +
    '\n\nAsk once, early, with one or two questions and a recommended option first; do the work that does not depend on the answer meanwhile.' +
    '\n\nConstraints: 1–4 questions (prefer 1–2); 2–4 options per question; header ≤ 12 characters.' +
    ' Each question automatically appends an "Other…" free-text option so users can provide answers outside the given choices.',
  inputSchema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        description:
          'List of questions (1–4). Each question contains: header (≤12-character short label), question (full question text),' +
          ' multiSelect (true=multiple choice / false=single choice), options (2–4 choices, each with a label and optional description).',
        items: {
          type: 'object',
          properties: {
            header: {
              type: 'string',
              description: 'Short label ≤12 characters that identifies the question, e.g. "Format", "Deploy target"',
            },
            question: {
              type: 'string',
              description: 'Full question text that clearly describes the choice the user needs to make',
            },
            multiSelect: {
              type: 'boolean',
              description: 'true = multiple selection (can select multiple options); false = single selection',
            },
            options: {
              type: 'array',
              description: '2–4 options',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string', description: 'Option label' },
                  description: { type: 'string', description: 'Optional supplementary description' },
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
    const t = getI18n().toolResult.askUserQuestion;
    const questions = input.questions as unknown[];

    // ── Validate input ──────────────────────────────────────────────────
    if (!Array.isArray(questions) || questions.length < 1 || questions.length > 4) {
      throw new Error(
        format(t.errQuestionsLength, {
          received: Array.isArray(questions) ? String(questions.length) : typeof questions,
        }),
      );
    }

    for (let i = 0; i < questions.length; i++) {
      const q = questions[i] as Record<string, unknown>;
      const idx = i + 1;

      if (typeof q.header !== 'string' || q.header.trim() === '') {
        throw new Error(format(t.errHeaderEmpty, { idx: String(idx) }));
      }
      if (q.header.length > 12) {
        throw new Error(
          format(t.errHeaderTooLong, {
            idx: String(idx),
            header: q.header,
            len: String(q.header.length),
          }),
        );
      }
      if (typeof q.question !== 'string' || q.question.trim() === '') {
        throw new Error(format(t.errQuestionEmpty, { idx: String(idx) }));
      }
      if (typeof q.multiSelect !== 'boolean') {
        throw new Error(
          format(t.errMultiSelectType, { idx: String(idx), received: typeof q.multiSelect }),
        );
      }
      const opts = q.options as unknown[];
      if (!Array.isArray(opts) || opts.length < 2 || opts.length > 4) {
        throw new Error(
          format(t.errOptionsLength, {
            idx: String(idx),
            received: Array.isArray(opts) ? String(opts.length) : typeof opts,
          }),
        );
      }
      for (let j = 0; j < opts.length; j++) {
        const opt = opts[j] as Record<string, unknown>;
        if (typeof opt.label !== 'string' || opt.label.trim() === '') {
          throw new Error(format(t.errOptionLabelEmpty, { idx: String(idx), j: String(j) }));
        }
      }
    }

    // ── Suspend until user answers ───────────────────────────────────────
    const toolCallId = context?.toolCallId;
    const conversationId = context?.conversationId ?? '';

    if (!toolCallId) {
      // Defensive: toolExecutor always injects this. If absent, surface as
      // an error so the model is told why, rather than hanging forever.
      throw new Error(t.errNoToolCallId);
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
      return t.cancelled;
    }

    const sep = getI18n().toolResult.listSeparator;
    const lines: string[] = [t.answersHeader];
    result.answers.forEach((ans, i) => {
      lines.push(`${i + 1}. [${ans.header}] ${ans.question}`);
      lines.push(`   → ${ans.selected.join(sep)}`);
    });
    return lines.join('\n');
  },
  isConcurrencySafe: false,
};
