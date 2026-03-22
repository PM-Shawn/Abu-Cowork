/**
 * Skill evaluation tools — Abu's equivalent of `claude -p` based eval pipeline.
 *
 * These tools let skill-creator test and optimize skills using Abu's own LLM,
 * regardless of which model the user has configured.
 */

import type { ToolDefinition } from '../../../types';
import { llmCall } from '../../llm/llmCall';
import { skillLoader } from '../../skill/loader';
import { TOOL_NAMES } from '../toolNames';

// ─── test_skill_trigger ─────────────────────────────────────────────────────

interface TriggerQuery {
  query: string;
  should_trigger: boolean;
}

interface TriggerResult {
  query: string;
  should_trigger: boolean;
  did_trigger: boolean;
  pass: boolean;
}

/**
 * Build the available skills list as it would appear in Abu's system prompt,
 * with the target skill's description overridden.
 */
function buildSkillsList(
  targetName: string,
  targetDescription: string,
): string {
  const allSkills = skillLoader.getAvailableSkills();
  const lines: string[] = [];

  for (const skill of allSkills) {
    if (skill.name === targetName) {
      lines.push(`- **${targetName}**: ${targetDescription}`);
    } else {
      lines.push(`- **${skill.name}**: ${skill.description || '(no description)'}`);
    }
  }

  // If target skill isn't in the list yet (new skill), add it
  if (!allSkills.some((s: { name: string }) => s.name === targetName)) {
    lines.push(`- **${targetName}**: ${targetDescription}`);
  }

  return lines.join('\n');
}

export const testSkillTriggerTool: ToolDefinition = {
  name: TOOL_NAMES.TEST_SKILL_TRIGGER,
  description: '测试一个技能的 description 是否能被特定查询正确触发。输入技能名称、描述和测试查询，返回每条查询的触发结果和总体通过率。等同于 Claude Code 的 run_eval.py。',
  inputSchema: {
    type: 'object',
    properties: {
      skill_name: { type: 'string', description: 'Name of the skill to test' },
      skill_description: { type: 'string', description: 'Description text to test (the triggering text)' },
      queries: {
        type: 'array',
        description: 'Test queries, each with expected trigger behavior',
        items: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'User query to test' },
            should_trigger: { type: 'string', description: '"true" or "false" — whether this query should trigger the skill' },
          },
          required: ['query', 'should_trigger'],
        },
      },
    },
    required: ['skill_name', 'skill_description', 'queries'],
  },
  execute: async (input) => {
    const skillName = input.skill_name as string;
    const skillDescription = input.skill_description as string;
    const rawQueries = input.queries as Array<{ query: string; should_trigger: string | boolean }>;

    const queries: TriggerQuery[] = rawQueries.map(q => ({
      query: q.query,
      should_trigger: q.should_trigger === true || q.should_trigger === 'true',
    }));

    if (queries.length === 0) {
      return 'Error: 至少需要一条测试查询。';
    }

    const skillsList = buildSkillsList(skillName, skillDescription);

    const systemPrompt = `你是一个AI助手。你有以下可用技能：

${skillsList}

当用户给你一个任务时，如果某个技能匹配这个任务，你应该使用 use_skill 工具来激活它。
如果没有技能匹配，直接回答用户即可，不要使用任何工具。

重要：只在任务真正需要该技能时才使用 use_skill。不要对简单的、不需要专门技能的任务使用技能。`;

    const useSkillToolDef: ToolDefinition = {
      name: 'use_skill',
      description: '激活一个技能',
      inputSchema: {
        type: 'object',
        properties: {
          skill_name: { type: 'string', description: 'Name of skill to activate' },
        },
        required: ['skill_name'],
      },
      execute: async () => '',
    };

    const results: TriggerResult[] = [];

    for (const q of queries) {
      try {
        const response = await llmCall({
          system: systemPrompt,
          messages: [{ role: 'user', content: q.query }],
          tools: [useSkillToolDef],
          maxTokens: 256,
        });

        const didTrigger = response.toolCalls.some(
          tc => tc.name === 'use_skill' && tc.input.skill_name === skillName
        );

        results.push({
          query: q.query,
          should_trigger: q.should_trigger,
          did_trigger: didTrigger,
          pass: didTrigger === q.should_trigger,
        });
      } catch {
        results.push({
          query: q.query,
          should_trigger: q.should_trigger,
          did_trigger: false,
          pass: false,
        });
      }
    }

    const passed = results.filter(r => r.pass).length;
    const total = results.length;
    const passRate = total > 0 ? (passed / total * 100).toFixed(0) : '0';

    const details = results.map(r => {
      const status = r.pass ? '✅ PASS' : '❌ FAIL';
      const expected = r.should_trigger ? 'should trigger' : 'should NOT trigger';
      const actual = r.did_trigger ? 'triggered' : 'not triggered';
      return `${status} | ${expected} | ${actual} | "${r.query}"`;
    }).join('\n');

    return JSON.stringify({
      skill_name: skillName,
      description: skillDescription,
      summary: { total, passed, failed: total - passed, pass_rate: `${passRate}%` },
      results,
    }, null, 2) + `\n\n概览: ${passed}/${total} 通过 (${passRate}%)\n\n${details}`;
  },
};

// ─── improve_skill_description ──────────────────────────────────────────────

export const improveSkillDescriptionTool: ToolDefinition = {
  name: TOOL_NAMES.IMPROVE_SKILL_DESCRIPTION,
  description: '根据触发测试结果，使用 LLM 优化技能的 description 以提升触发准确率。传入当前描述、测试结果、技能内容，返回改进版描述。等同于 Claude Code 的 improve_description.py。',
  inputSchema: {
    type: 'object',
    properties: {
      skill_name: { type: 'string', description: 'Skill name' },
      current_description: { type: 'string', description: 'Current skill description to improve' },
      skill_content: { type: 'string', description: 'Full SKILL.md content (for context)' },
      eval_results: { type: 'string', description: 'JSON string of test_skill_trigger results' },
    },
    required: ['skill_name', 'current_description', 'eval_results'],
  },
  execute: async (input) => {
    const skillName = input.skill_name as string;
    const currentDescription = input.current_description as string;
    const skillContent = (input.skill_content as string) || '';
    const evalResultsStr = input.eval_results as string;

    let evalResults: { results?: TriggerResult[] };
    try {
      evalResults = JSON.parse(evalResultsStr);
    } catch {
      return 'Error: eval_results 不是有效的 JSON。请传入 test_skill_trigger 的返回结果。';
    }

    const results = evalResults.results || [];
    const failedTriggers = results.filter(r => r.should_trigger && !r.pass);
    const falseTriggers = results.filter(r => !r.should_trigger && !r.pass);

    let failureInfo = '';
    if (failedTriggers.length > 0) {
      failureInfo += '未触发（应该触发但没触发）：\n';
      failureInfo += failedTriggers.map(r => `  - "${r.query}"`).join('\n') + '\n\n';
    }
    if (falseTriggers.length > 0) {
      failureInfo += '误触发（不应该触发但触发了）：\n';
      failureInfo += falseTriggers.map(r => `  - "${r.query}"`).join('\n') + '\n\n';
    }

    if (!failureInfo) {
      return `当前描述已经 100% 通过测试，无需优化。\n\n当前描述：${currentDescription}`;
    }

    const prompt = `你在优化一个技能（skill）的 description。这个 description 会出现在 AI 助手的可用技能列表中，AI 根据这个描述决定是否使用该技能。

技能名称: "${skillName}"

当前描述:
"${currentDescription}"

${failureInfo}

${skillContent ? `技能内容（供参考）：\n${skillContent.slice(0, 2000)}\n` : ''}

请写一个改进版描述，要求：
1. 不超过 200 词 / 1024 字符
2. 用祈使句（"Use this skill when..."）
3. 聚焦用户意图，而非实现细节
4. 从失败案例中泛化，不要针对具体 query 做特殊处理
5. 让该技能在众多技能中脱颖而出

只返回新的描述文本，不要加任何解释或标记。`;

    try {
      const response = await llmCall({
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 1024,
      });

      const newDescription = response.text.trim().replace(/^["']|["']$/g, '');

      return JSON.stringify({
        original_description: currentDescription,
        improved_description: newDescription,
        char_count: newDescription.length,
        over_limit: newDescription.length > 1024,
      }, null, 2);
    } catch (err) {
      return `Error: LLM 调用失败 — ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
