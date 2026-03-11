/**
 * Project Rules — user-maintained project rules (ABU.md)
 *
 * Rules are manually maintained by users (committed to git, high priority).
 * This is separate from AI-written memories (.abu/MEMORY.md).
 *
 * File structure:
 *   ~/.abu/ABU.md                    — User-level rules (cross-project)
 *   {workspace}/.abu/ABU.md          — Project main rules
 *   {workspace}/.abu/rules/*.md      — Modular rules (alphabetical)
 */

import { readTextFile, readDir, exists, mkdir } from '@tauri-apps/plugin-fs';
import { homeDir } from '@tauri-apps/api/path';
import { joinPath } from '../../utils/pathUtils';
import { writeTextFile } from '@tauri-apps/plugin-fs';

const MAX_USER_RULES_CHARS = 4000;
const MAX_PROJECT_RULES_CHARS = 8000;
const MAX_RULE_FILES = 20;

// Cache homeDir to avoid repeated IPC calls
let cachedHomeDir: string | null = null;

async function getCachedHomeDir(): Promise<string> {
  if (!cachedHomeDir) {
    cachedHomeDir = await homeDir();
  }
  return cachedHomeDir;
}

/**
 * Read a text file safely, returning empty string on error.
 */
async function safeReadTextFile(path: string): Promise<string> {
  try {
    return await readTextFile(path);
  } catch {
    return '';
  }
}

/**
 * Load user-level rules from ~/.abu/ABU.md
 */
export async function loadUserRules(): Promise<string> {
  const home = await getCachedHomeDir();
  const rulesPath = joinPath(home, '.abu', 'ABU.md');
  const content = await safeReadTextFile(rulesPath);
  if (!content) return '';
  if (content.length > MAX_USER_RULES_CHARS) {
    return content.slice(0, MAX_USER_RULES_CHARS) + '\n...(用户规则已截断)';
  }
  return content;
}

/**
 * Load project main rules from {workspace}/.abu/ABU.md
 */
export async function loadProjectRules(workspacePath: string): Promise<string> {
  const rulesPath = joinPath(workspacePath, '.abu', 'ABU.md');
  return await safeReadTextFile(rulesPath);
}

/**
 * Load modular rules from {workspace}/.abu/rules/*.md
 * Files are sorted alphabetically, max MAX_RULE_FILES files.
 * Each file is prefixed with "### {filename}" header.
 */
export async function loadModularRules(workspacePath: string): Promise<string> {
  const rulesDir = joinPath(workspacePath, '.abu', 'rules');
  try {
    if (!(await exists(rulesDir))) return '';
    const entries = await readDir(rulesDir);
    const mdFiles = entries
      .filter(e => !e.isDirectory && e.name.endsWith('.md'))
      .map(e => e.name)
      .sort()
      .slice(0, MAX_RULE_FILES);

    if (mdFiles.length === 0) return '';

    const parts: string[] = [];
    for (const fileName of mdFiles) {
      const filePath = joinPath(rulesDir, fileName);
      const content = await safeReadTextFile(filePath);
      if (content.trim()) {
        parts.push(`### ${fileName}\n${content.trim()}`);
      }
    }
    return parts.join('\n\n');
  } catch {
    return '';
  }
}

/**
 * Load all rules by priority (low → high):
 * 1. User-level rules (~/.abu/ABU.md)
 * 2. Project main rules ({workspace}/.abu/ABU.md)
 * 3. Modular rules ({workspace}/.abu/rules/*.md)
 *
 * Total budget: MAX_USER_RULES_CHARS + MAX_PROJECT_RULES_CHARS
 */
export async function loadAllRules(workspacePath: string | null): Promise<string> {
  const parts: string[] = [];

  // 1. User-level rules
  try {
    const userRules = await loadUserRules();
    if (userRules.trim()) {
      parts.push(`### 用户规则（~/.abu/ABU.md）\n${userRules.trim()}`);
    }
  } catch (err) {
    console.warn('Failed to load user rules:', err);
  }

  // 2 & 3. Project rules (main + modular)
  if (workspacePath) {
    try {
      const projectRules = await loadProjectRules(workspacePath);
      if (projectRules.trim()) {
        parts.push(`### 项目规则（.abu/ABU.md）\n${projectRules.trim()}`);
      }
    } catch (err) {
      console.warn('Failed to load project rules:', err);
    }

    try {
      const modularRules = await loadModularRules(workspacePath);
      if (modularRules.trim()) {
        parts.push(`### 模块化规则（.abu/rules/）\n${modularRules.trim()}`);
      }
    } catch (err) {
      console.warn('Failed to load modular rules:', err);
    }
  }

  if (parts.length === 0) return '';

  let result = parts.join('\n\n');

  // Enforce total budget
  const totalBudget = MAX_USER_RULES_CHARS + MAX_PROJECT_RULES_CHARS;
  if (result.length > totalBudget) {
    result = result.slice(0, totalBudget) + '\n...(规则已截断，请精简规则内容)';
  }

  return result;
}

/**
 * Initialize workspace rules: create template .abu/ABU.md and .abu/rules/ directory.
 * Returns a description of what was created.
 */
export async function initWorkspaceRules(workspacePath: string): Promise<string> {
  const abuDir = joinPath(workspacePath, '.abu');
  const rulesFile = joinPath(abuDir, 'ABU.md');
  const rulesDir = joinPath(abuDir, 'rules');
  const results: string[] = [];

  // Check if ABU.md already exists
  if (await exists(rulesFile)) {
    return '`.abu/ABU.md` 已存在，请直接编辑或使用 /init 技能让 AI 帮助改进。';
  }

  // Ensure .abu directory exists
  try {
    if (!(await exists(abuDir))) {
      await mkdir(abuDir, { recursive: true });
    }
  } catch (err) {
    console.warn('Failed to create .abu directory:', err);
  }

  // Create template ABU.md
  const template = `# 项目规则

<!--
  这是项目规则文件，由团队成员手动维护。
  Abu 会在每次对话中加载这些规则并严格遵守。
  建议提交到 git，与团队共享。

  注意：.abu/MEMORY.md 是 AI 自动记忆，不要提交到 git。
-->

## 项目概述
<!-- 简述项目名称、用途 -->

## 技术栈
<!-- 列出主要技术栈 -->

## 编码规范
<!-- 编码风格、命名约定等 -->

## 构建与运行
<!-- 常用命令 -->

## 其他约定
<!-- 团队特定的约定 -->
`;

  try {
    await writeTextFile(rulesFile, template);
    results.push('创建了 `.abu/ABU.md` 规则模板');
  } catch (err) {
    results.push(`创建 ABU.md 失败: ${err}`);
  }

  // Create rules directory
  try {
    if (!(await exists(rulesDir))) {
      await mkdir(rulesDir, { recursive: true });
      results.push('创建了 `.abu/rules/` 目录');
    }
  } catch (err) {
    results.push(`创建 rules 目录失败: ${err}`);
  }

  return results.join('\n');
}
