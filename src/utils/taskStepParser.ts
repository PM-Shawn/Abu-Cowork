import type { TaskStep } from '../stores/taskProgressStore';
import { TOOL_NAMES } from '@/core/tools/toolNames';

/**
 * Parse task steps from AI response text
 * Supports multiple formats:
 * - Numbered list: "1. xxx 2. xxx"
 * - Markdown checklist: "- [ ] xxx"
 * - Chinese format: "第一步：xxx"
 * - Simple dash list: "- xxx"
 */

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

/**
 * Parse numbered list format (1. xxx, 2. xxx)
 */
function parseNumberedList(text: string): TaskStep[] {
  const steps: TaskStep[] = [];
  // Match patterns like "1. do something" or "1) do something"
  const regex = /(?:^|\n)\s*(\d+)[.）)]\s*(.+?)(?=\n\s*\d+[.）)]|\n\n|$)/gs;
  let match;

  while ((match = regex.exec(text)) !== null) {
    const label = match[2].trim();
    if (label && label.length > 0 && label.length < 100) {
      steps.push({
        id: generateId(),
        label,
        status: 'pending',
      });
    }
  }

  return steps;
}

/**
 * Parse markdown checklist format (- [ ] xxx)
 */
function parseMarkdownChecklist(text: string): TaskStep[] {
  const steps: TaskStep[] = [];
  const regex = /(?:^|\n)\s*-\s*\[[ x]\]\s*(.+?)(?=\n|$)/gi;
  let match;

  while ((match = regex.exec(text)) !== null) {
    const label = match[1].trim();
    if (label && label.length > 0 && label.length < 100) {
      steps.push({
        id: generateId(),
        label,
        status: 'pending',
      });
    }
  }

  return steps;
}

/**
 * Parse Chinese step format (第一步：xxx)
 */
function parseChineseSteps(text: string): TaskStep[] {
  const steps: TaskStep[] = [];
  // Match patterns like "第一步：xxx" or "步骤1：xxx"
  const regex = /(?:第[一二三四五六七八九十\d]+步|步骤\s*\d+)[：:]\s*(.+?)(?=\n第[一二三四五六七八九十\d]+步|\n步骤\s*\d+|$)/gs;
  let match;

  while ((match = regex.exec(text)) !== null) {
    const label = match[1].trim();
    if (label && label.length > 0 && label.length < 100) {
      steps.push({
        id: generateId(),
        label,
        status: 'pending',
      });
    }
  }

  return steps;
}

/**
 * Parse simple dash list format (- xxx)
 */
function parseDashList(text: string): TaskStep[] {
  const steps: TaskStep[] = [];
  // Only match if inside a "steps" or "plan" context
  const regex = /(?:^|\n)\s*[-•]\s+(.+?)(?=\n\s*[-•]|\n\n|$)/gs;
  let match;

  while ((match = regex.exec(text)) !== null) {
    const label = match[1].trim();
    // Filter out labels that are too short or too long
    if (label && label.length > 2 && label.length < 100) {
      // Skip if looks like a comment or description
      if (!label.startsWith('(') && !label.startsWith('注')) {
        steps.push({
          id: generateId(),
          label,
          status: 'pending',
        });
      }
    }
  }

  return steps;
}

/**
 * Check if text contains step/plan markers
 */
function hasStepMarkers(text: string): boolean {
  const markers = [
    '## 步骤',
    '## 计划',
    '计划如下',
    '步骤如下',
    '我会',
    '我来',
    '首先',
    '接下来',
    'Steps:',
    'Plan:',
    'I will',
    "I'll",
    'First,',
    'Then,',
  ];
  return markers.some((marker) => text.includes(marker));
}

/**
 * Extract section containing steps/plan
 */
function extractStepSection(text: string): string | null {
  // Try to find a section that contains steps
  const sectionMarkers = [
    /##\s*步骤[\s\S]*?(?=##|$)/i,
    /##\s*计划[\s\S]*?(?=##|$)/i,
    /##\s*Steps[\s\S]*?(?=##|$)/i,
    /##\s*Plan[\s\S]*?(?=##|$)/i,
    /计划如下[:：]?[\s\S]*?(?=\n\n|$)/,
    /步骤如下[:：]?[\s\S]*?(?=\n\n|$)/,
  ];

  for (const marker of sectionMarkers) {
    const match = text.match(marker);
    if (match) {
      return match[0];
    }
  }

  return null;
}

/**
 * Main parser function - tries multiple formats and returns best match
 */
export function parseTaskSteps(text: string): TaskStep[] {
  // First check if text contains step markers
  if (!hasStepMarkers(text)) {
    return [];
  }

  // Try to extract just the step section
  const stepSection = extractStepSection(text) || text;

  // Try different parsers in order of specificity
  let steps = parseNumberedList(stepSection);
  if (steps.length >= 2) return steps;

  steps = parseMarkdownChecklist(stepSection);
  if (steps.length >= 2) return steps;

  steps = parseChineseSteps(stepSection);
  if (steps.length >= 2) return steps;

  steps = parseDashList(stepSection);
  if (steps.length >= 2) return steps;

  return [];
}

/**
 * Try to match a tool call to a parsed step
 * Uses keyword matching to find the best match
 */
export function matchToolCallToStep(
  toolName: string,
  toolInput: Record<string, unknown>,
  steps: TaskStep[]
): TaskStep | null {
  const pendingSteps = steps.filter((s) => s.status === 'pending' || s.status === 'running');
  if (pendingSteps.length === 0) return null;

  // Extract keywords from tool call
  const keywords: string[] = [];

  // Add path-related keywords
  const path = (toolInput.path || toolInput.file_path || toolInput.filePath) as string | undefined;
  if (path) {
    const fileName = path.split(/[/\\]/).pop() || '';
    keywords.push(fileName.toLowerCase());
    // Add parent directory name
    const parts = path.split(/[/\\]/);
    if (parts.length > 1) {
      keywords.push(parts[parts.length - 2].toLowerCase());
    }
  }

  // Add command-related keywords
  const command = (toolInput.command || toolInput.cmd) as string | undefined;
  if (command) {
    keywords.push(...command.toLowerCase().split(/\s+/).slice(0, 3));
  }

  // Add query-related keywords
  const query = (toolInput.query || toolInput.pattern) as string | undefined;
  if (query) {
    keywords.push(query.toLowerCase());
  }

  // Add tool-specific keywords
  const toolKeywords: Record<string, string[]> = {
    [TOOL_NAMES.LIST_DIRECTORY]: ['目录', '文件夹', '列出', 'directory', 'folder', 'list'],
    [TOOL_NAMES.READ_FILE]: ['读取', '读', '看', 'read', 'view'],
    [TOOL_NAMES.WRITE_FILE]: ['写入', '写', '保存', 'write', 'save'],
    [TOOL_NAMES.RUN_COMMAND]: ['执行', '运行', 'run', 'execute'],
    [TOOL_NAMES.GET_SYSTEM_INFO]: ['系统', '信息', 'system', 'info'],
  };

  if (toolKeywords[toolName]) {
    keywords.push(...toolKeywords[toolName]);
  }

  // Score each step
  let bestMatch: TaskStep | null = null;
  let bestScore = 0;

  for (const step of pendingSteps) {
    const stepText = step.label.toLowerCase();
    let score = 0;

    for (const keyword of keywords) {
      if (keyword && stepText.includes(keyword)) {
        score++;
      }
    }

    // Bonus for tool type match
    if (toolName === TOOL_NAMES.LIST_DIRECTORY && (stepText.includes('找') || stepText.includes('查看'))) {
      score += 2;
    }
    if (toolName === TOOL_NAMES.READ_FILE && (stepText.includes('读') || stepText.includes('内容'))) {
      score += 2;
    }
    if (toolName === TOOL_NAMES.WRITE_FILE && (stepText.includes('写') || stepText.includes('重命名') || stepText.includes('保存'))) {
      score += 2;
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = step;
    }
  }

  // Only return if we have a reasonable match
  return bestScore >= 1 ? bestMatch : pendingSteps[0] || null;
}

/**
 * Infer steps from tool calls when no explicit plan is found
 */
export function inferStepsFromToolCalls(
  toolName: string,
  toolInput: Record<string, unknown>
): TaskStep {
  const id = generateId();

  // Generate label based on tool type
  let label: string;
  const path = (toolInput.path || toolInput.file_path || toolInput.filePath) as string | undefined;
  const fileName = path ? path.split(/[/\\]/).pop() : undefined;

  switch (toolName) {
    case TOOL_NAMES.LIST_DIRECTORY:
      label = fileName ? `查看 ${fileName} 文件夹` : '查看文件夹内容';
      break;
    case TOOL_NAMES.READ_FILE:
      label = fileName ? `读取 ${fileName}` : '读取文件';
      break;
    case TOOL_NAMES.WRITE_FILE:
      label = fileName ? `写入 ${fileName}` : '写入文件';
      break;
    case TOOL_NAMES.RUN_COMMAND: {
      const cmd = (toolInput.command || toolInput.cmd) as string | undefined;
      const shortCmd = cmd ? cmd.slice(0, 20) + (cmd.length > 20 ? '...' : '') : '';
      label = shortCmd ? `执行 ${shortCmd}` : '执行命令';
      break;
    }
    case TOOL_NAMES.GET_SYSTEM_INFO:
      label = '获取系统信息';
      break;
    default:
      label = `使用 ${toolName}`;
  }

  return {
    id,
    label,
    status: 'running',
    detail: path,
    startTime: Date.now(),
  };
}
