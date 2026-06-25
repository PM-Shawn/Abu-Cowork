/**
 * Conditional tool loading — reduces tool token overhead by only injecting
 * tools when they're likely needed based on user input keywords.
 *
 * Core tools (~16) are always loaded. Conditional tools (~14) are loaded
 * only when keyword matching or settings indicate they're needed.
 */

import type { Skill } from '../../types';
import { TOOL_NAMES } from './toolNames';

/** Tools always present in every turn (~3000 tokens) */
export const CORE_TOOL_NAMES: ReadonlySet<string> = new Set([
  TOOL_NAMES.READ_FILE,
  TOOL_NAMES.WRITE_FILE,
  TOOL_NAMES.EDIT_FILE,
  TOOL_NAMES.LIST_DIRECTORY,
  TOOL_NAMES.SEARCH_FILES,
  TOOL_NAMES.FIND_FILES,
  TOOL_NAMES.RUN_COMMAND,
  TOOL_NAMES.WEB_SEARCH,
  TOOL_NAMES.HTTP_FETCH,
  TOOL_NAMES.REQUEST_WORKSPACE,
  // ask_user_question 常驻 core —— 对齐 Claude（其 bundle 里 AskUserQuestion 与
  // ToolSearch 并列常驻、不走延迟加载）。否则弱模型走不通 tool_search→调用 的链路，
  // 会误判“工具不可用”并退化成纯文本提问。
  TOOL_NAMES.ASK_USER_QUESTION,
  TOOL_NAMES.USE_SKILL,
  TOOL_NAMES.DELEGATE_TO_AGENT,
  TOOL_NAMES.TOOL_SEARCH,
]);

/** Keyword → tool mapping for demand-based loading */
const PREFETCH_RULES: ReadonlyArray<{
  keywords: readonly string[];
  tools: readonly string[];
}> = [
  {
    keywords: ['定时', '计划', '每天', '每周', '自动执行', 'schedule', 'cron'],
    tools: [TOOL_NAMES.MANAGE_SCHEDULED_TASK],
  },
  {
    keywords: ['触发', '监听', '事件', '自动响应', 'trigger', 'webhook'],
    tools: [TOOL_NAMES.MANAGE_TRIGGER],
  },
  {
    keywords: ['文件变化', '文件监听', '新文件', 'watch'],
    tools: [TOOL_NAMES.MANAGE_FILE_WATCH],
  },
  {
    keywords: ['图片', '图像', '照片', '画', '生成图', 'image', 'dall'],
    tools: [TOOL_NAMES.GENERATE_IMAGE, TOOL_NAMES.PROCESS_IMAGE],
  },
  {
    keywords: ['缩放', '裁剪', '压缩图', '转换格式', 'resize', 'crop'],
    tools: [TOOL_NAMES.PROCESS_IMAGE],
  },
  {
    keywords: ['剪贴板', '粘贴板', '复制的', '粘贴', 'clipboard'],
    tools: [TOOL_NAMES.CLIPBOARD_READ, TOOL_NAMES.CLIPBOARD_WRITE],
  },
  {
    keywords: ['创建技能', '保存技能', '新技能', '修改技能', '创建代理', '新代理'],
    tools: [TOOL_NAMES.SKILL_MANAGE, TOOL_NAMES.SAVE_AGENT, TOOL_NAMES.TEST_SKILL_TRIGGER, TOOL_NAMES.IMPROVE_SKILL_DESCRIPTION],
  },
  {
    keywords: ['mcp', '工具服务', '缺少工具', '安装服务'],
    tools: [TOOL_NAMES.MANAGE_MCP_SERVER],
  },
  {
    keywords: ['之前', '上次', '最近', '记得', '回忆', '干了什么', '干了啥', '聊过', '做过', '历史', 'recall', '记忆'],
    tools: [TOOL_NAMES.RECALL],
  },
  {
    // Save-to-memory triggers — promote update_memory so the model sees its
    // detailed schema (where the memory-writing conventions now live after
    // v0.18.6 slashed the always-on memory-mgmt section).
    keywords: ['记住这个', '记住这一点', '帮我记下', '帮我记住', '记下来', '别忘了', '请记住', '保存到记忆', '存进记忆', 'remember this', 'save to memory'],
    tools: [TOOL_NAMES.UPDATE_MEMORY],
  },
  {
    keywords: ['通知我', '提醒我', '完成后通知', 'notify'],
    tools: [TOOL_NAMES.SYSTEM_NOTIFY],
  },
  {
    keywords: ['截屏', '截图', '屏幕', '打开应用', '点击', '操控电脑', '操作电脑', '鼠标', '键盘', 'screenshot', 'click', 'computer use', '帮我打开', '帮我点'],
    tools: [TOOL_NAMES.COMPUTER],
  },
];

export interface PrefetchContext {
  userInput: string;
  computerUseEnabled: boolean;
  activeSkills: Skill[];
  turnCount: number;
}

/**
 * Determine which conditional tools should be loaded for this turn.
 *
 * Returns tool names to add on top of CORE_TOOL_NAMES.
 * Skill allowed-tools whitelist takes priority — when a skill defines
 * allowed-tools, prefetch is skipped entirely (handled by resolveTools).
 */
export function prefetchTools(ctx: PrefetchContext): string[] {
  const additionalTools: string[] = [];
  const lower = ctx.userInput.toLowerCase();

  // Keyword matching
  for (const rule of PREFETCH_RULES) {
    if (rule.keywords.some(k => lower.includes(k))) {
      additionalTools.push(...rule.tools);
    }
  }

  // Computer use: load when enabled (auto-enabled on first call) OR via keyword prefetch
  if (ctx.computerUseEnabled) {
    additionalTools.push(TOOL_NAMES.COMPUTER);
  }

  // Active skill exists → may need read_skill_file
  if (ctx.activeSkills.length > 0) {
    additionalTools.push(TOOL_NAMES.READ_SKILL_FILE);
  }

  // Early turns: load planning + system info tools (LLM may plan after initial research)
  if (ctx.turnCount <= 3) {
    additionalTools.push(TOOL_NAMES.REPORT_PLAN);
  }
  if (ctx.turnCount === 0) {
    additionalTools.push(TOOL_NAMES.GET_SYSTEM_INFO);
  }

  // Non-first turns: load task tracking + memory tools
  if (ctx.turnCount > 0) {
    additionalTools.push(TOOL_NAMES.TODO_WRITE);
  }
  if (ctx.turnCount > 2) {
    additionalTools.push(TOOL_NAMES.LOG_TASK_COMPLETION);
    additionalTools.push(TOOL_NAMES.UPDATE_MEMORY);
  }

  return [...new Set(additionalTools)];
}
