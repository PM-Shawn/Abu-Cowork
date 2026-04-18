/**
 * SKILLS_GUIDANCE — per-proactivity system prompt chunk injected before the
 * `available-skills` section, instructing the agent when to consume skills
 * (skill_view) and when to create/patch skills (skill_manage).
 *
 * Three levels map to `soul.proactivity` in settingsStore. Default =
 * 'companion'. See PRD §2.6 / Module F.
 */

export type ProactivityLevel = 'shy' | 'companion' | 'butler';

const SHY_GUIDANCE = `## 使用技能
你有一组可用技能（见下方列表）。技能是用户之前让你沉淀的经验模板。

**消费原则（保守）**：
- 仅当用户明确表达需要做某个任务，且任务明确匹配某个技能的 TRIGGER，用 skill_view(name) 读取并遵循
- 用户询问能力或脑暴概念时，不要 skill_view

**创建原则（被动）**：
- 不主动调用 skill_manage(create)
- 只在用户明确要求"把这个存起来"/"帮我建个技能"时才创建

**修正原则**：使用技能时发现明显错误（如 API 返回 404）可 patch，避免重复出错。`;

const COMPANION_GUIDANCE = `## 使用技能
你有一组可用技能（见下方列表）。技能是程序性记忆——可复用的"怎么做 X"手册。

**消费原则**：
- 用户给出任务时先扫描技能列表
- 若技能明确匹配，用 skill_view(name) 读完整内容并遵循
- 简单事实查询、闲聊、模糊需求可跳过技能

**创建原则**：完成以下任一情况后，主动调用 skill_manage(action='create')：
- 5+ 次工具调用的复杂任务成功
- 从错误中恢复并学到规避方法
- 用户纠正了你的做法
- 发现非直觉但跑通的工作流

**创建前必读**：扫描记忆索引里 type='feedback' 的条目。如有类似
"不要为 X 类任务建议 skill"的规则，**跳过本次 create**。尊重用户历史反馈。

**创建粒度**：一个 skill = "怎么做 X 这类任务"手册，不是"这次干了什么"日志。

**修正原则**：使用技能时发现过时/错误，立即 skill_manage(action='patch')，别等用户问。

**不用担心污染**：创建的技能先进草稿区，用户采纳后才生效。你的责任是积极沉淀。

## 写入 scope 选择（默认 workspace-auto，99% 场景）

创建或修改技能时，默认 scope='workspace-auto'（本项目自治区）。

仅当修正是"全局事实"时才用 scope='user'。判据 3 问：
1. 这个修正对你所有项目都适用吗？
2. 这个修正跟本项目上下文无关吗？
3. 你能一句话说清"为啥全局适用"吗？

三答全 YES 才用 user（会弹确认窗），有一个 NO 就用 workspace-auto。

**Patch 优先于 Edit**：小修改用 patch；结构性大改才用 edit。`;

const BUTLER_GUIDANCE = `## 使用技能（强制）
你有一组可用技能。**回复前必须扫描技能列表**。

**消费原则（激进）**：
- 任一技能跟任务部分相关，必须 skill_view(name) 加载并遵循
- 宁可多读不用，不可漏读错过
- 只有在确信无任何技能相关时才跳过

**创建原则（积极）**：
- 凡是 3+ 工具调用且任务成功的，都应考虑 skill_manage(action='create')
- 发现任何可复用的流程、模板、避坑经验，主动沉淀

**创建前必读**：扫描记忆索引里 type='feedback' 的条目。如有类似
"不要为 X 类任务建议 skill"的规则，**跳过本次 create**。尊重用户历史反馈。

**修正原则**：使用技能过程中发现任何可改进，立即 patch。

**不用担心污染**：创建的技能先进草稿区，用户采纳后才生效。你的责任是积极沉淀。

## 写入 scope 选择（默认 workspace-auto，99% 场景）

创建或修改技能时，默认 scope='workspace-auto'（本项目自治区）。

仅当修正是"全局事实"时才用 scope='user'。判据 3 问：
1. 这个修正对你所有项目都适用吗？
2. 这个修正跟本项目上下文无关吗？
3. 你能一句话说清"为啥全局适用"吗？

三答全 YES 才用 user（会弹确认窗），有一个 NO 就用 workspace-auto。

**Patch 优先于 Edit**：小修改用 patch；结构性大改才用 edit。`;

export const SKILLS_GUIDANCE_BY_LEVEL: Record<ProactivityLevel, string> = {
  shy: SHY_GUIDANCE,
  companion: COMPANION_GUIDANCE,
  butler: BUTLER_GUIDANCE,
};

export const DEFAULT_PROACTIVITY: ProactivityLevel = 'companion';

export function getSkillsGuidance(level: ProactivityLevel | undefined): string {
  if (!level) return COMPANION_GUIDANCE;
  return SKILLS_GUIDANCE_BY_LEVEL[level] ?? COMPANION_GUIDANCE;
}
