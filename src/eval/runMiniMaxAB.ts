#!/usr/bin/env tsx
/**
 * One-off A/B experiment: does strengthening report_plan mandate make MiniMax actually call it?
 *
 * Variant A (baseline): unchanged system prompt + unchanged report_plan tool description
 * Variant B (strengthened): replaces PLANNING_INSTRUCTION + report_plan description with
 *                           imperative single-rule wording
 *
 * Same 3 cases run against MiniMax-M2.7 via Anthropic protocol (custom base URL).
 *
 * NOT wired into run.ts. Standalone. Delete after experiment.
 */

import './shimTauri';

import Anthropic from '@anthropic-ai/sdk';
import { registerBuiltinTools } from '@/core/tools/builtins';
import { getAllTools } from '@/core/tools/registry';
import { buildSystemPromptSections, routeInput } from '@/core/agent/orchestrator';
import { sectionsToString } from '@/core/llm/promptSections';
import { prefetchTools } from '@/core/tools/toolPrefetch';
import { classifyTools, resetSessionPromotions } from '@/core/tools/toolSearch';
import type { ToolDefinition } from '@/types';

// MiniMax credentials — read from env, never hardcode.
// Usage:
//   MINIMAX_API_KEY=sk-cp-xxx npx tsx src/eval/runMiniMaxAB.ts
const API_KEY = process.env.MINIMAX_API_KEY;
const BASE_URL = 'https://api.minimaxi.com/anthropic';
const MODEL = 'MiniMax-M2.7';

if (!API_KEY) {
  console.error('Error: MINIMAX_API_KEY env var is not set.');
  console.error('Usage: MINIMAX_API_KEY=sk-cp-xxx npx tsx src/eval/runMiniMaxAB.ts');
  process.exit(1);
}

// 3 test cases targeting the report_plan mandate
const CASES = [
  {
    id: 'desktop-list',
    input: '看看桌面有什么',
    note: 'Production case (mnpzrnechvsjy3 turn 0). Single-step ish.',
  },
  {
    id: 'desktop-invoice',
    input: '帮我整理桌面发票',
    note: 'Standard multi-step example from PLANNING_EXAMPLES. Should plan.',
  },
  {
    id: 'pdf-move-and-count',
    input: '把 ~/Downloads 里的所有 PDF 移到 ~/Desktop/PDFs，移完之后告诉我移了多少个',
    note: 'Compound multi-step task. Should definitely plan.',
  },
];

// Variant B: strengthened wording
const VARIANT_B_PLANNING_TEXT = `
## 任务执行规则（强制）

**核心规则**：对于任何涉及 2 次或更多工具调用的任务，你的**第一个 tool_use 必须是 report_plan**，列出业务步骤。

- ✅ 多步任务 → 第一个动作 = report_plan，然后执行
- ✅ 单步任务（一次工具调用就完成）→ 直接执行，不 plan
- ❌ 不要先执行操作再补 plan
- ❌ 不要跳过 plan 直接连续调多个工具

判断标准：你预计要调用 ≥2 个工具，就先 plan。

### 工具选择原则
- 读文件 → read_file
- 列目录 → list_directory
- 找文件 → find_files
- 搜内容 → search_files
- 编辑文件 → edit_file
- 系统命令 → run_command（仅在专用工具不适用时）
- 网页搜索 → web_search（仅在确认本地没有相关资源后使用）
`;

const VARIANT_B_REPORT_PLAN_DESC = '【强制工具】上报任务执行计划。规则：任何预计涉及 ≥2 个工具调用的任务，第一个 tool_use 必须是 report_plan。在 plan 之前不要调用任何其他工具。简单单步任务可以跳过 plan。steps 描述用业务语言（"扫描桌面文件" 而不是 "调用 list_directory"）。';

interface CaseResult {
  variant: 'A' | 'B';
  caseId: string;
  toolsCalled: string[];
  firstTool: string | null;
  planCalled: boolean;
  planFirst: boolean;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  error?: string;
  textPreview?: string;
}

function convertTools(tools: ToolDefinition[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
  }));
}

async function buildPrompt(): Promise<string> {
  const route = routeInput('');
  const evalImContext = { platform: 'eval', workspacePath: '/eval/workspace' };
  const sections = await buildSystemPromptSections(route, '', 'eval-session', evalImContext, 0);
  return sectionsToString(sections);
}

function patchPromptVariantB(originalPrompt: string): string {
  // Find the PLANNING section by its known anchor and replace it.
  // The PLANNING_INSTRUCTION starts with "情况 A" enumeration; find that block.
  const startMarker = '### 情况 A';
  const endMarker = '多步任务的最后一步应该是验证';
  const startIdx = originalPrompt.indexOf(startMarker);
  if (startIdx === -1) {
    console.warn('[variant-b] could not find planning section start; using original');
    return originalPrompt;
  }
  // Find a reasonable end — look for end marker or next ## heading after start
  let endIdx = originalPrompt.indexOf(endMarker, startIdx);
  if (endIdx === -1) {
    console.warn('[variant-b] could not find planning section end; using original');
    return originalPrompt;
  }
  // Extend to end of that line
  endIdx = originalPrompt.indexOf('\n', endIdx);
  if (endIdx === -1) endIdx = originalPrompt.length;

  // Replace the whole planning region
  return originalPrompt.slice(0, startIdx) + VARIANT_B_PLANNING_TEXT.trim() + originalPrompt.slice(endIdx);
}

function patchToolsVariantB(tools: ToolDefinition[]): ToolDefinition[] {
  return tools.map((t) => {
    if (t.name === 'report_plan') {
      return { ...t, description: VARIANT_B_REPORT_PLAN_DESC };
    }
    return t;
  });
}

async function runOneCase(
  variant: 'A' | 'B',
  client: Anthropic,
  systemPrompt: string,
  tools: Anthropic.Tool[],
  c: typeof CASES[number],
): Promise<CaseResult> {
  const start = Date.now();
  const result: CaseResult = {
    variant,
    caseId: c.id,
    toolsCalled: [],
    firstTool: null,
    planCalled: false,
    planFirst: false,
    latencyMs: 0,
  };

  try {
    const stream = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      temperature: 0,
      system: systemPrompt,
      tools,
      stream: true,
      messages: [{ role: 'user', content: c.input }],
    });

    let currentToolName = '';
    let textContent = '';

    for await (const event of stream as AsyncIterable<Anthropic.MessageStreamEvent>) {
      switch (event.type) {
        case 'content_block_start':
          if (event.content_block.type === 'tool_use') {
            currentToolName = event.content_block.name;
          }
          break;
        case 'content_block_delta':
          if (event.delta.type === 'text_delta') {
            textContent += event.delta.text;
          }
          break;
        case 'content_block_stop':
          if (currentToolName) {
            result.toolsCalled.push(currentToolName);
            currentToolName = '';
          }
          break;
        case 'message_start':
          if (event.message.usage) {
            result.inputTokens = event.message.usage.input_tokens;
          }
          break;
        case 'message_delta':
          if (event.usage) {
            result.outputTokens = event.usage.output_tokens;
          }
          break;
      }
    }

    result.firstTool = result.toolsCalled[0] ?? null;
    result.planCalled = result.toolsCalled.includes('report_plan');
    result.planFirst = result.firstTool === 'report_plan';
    result.textPreview = textContent.slice(0, 120);
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
  }

  result.latencyMs = Date.now() - start;
  return result;
}

async function main() {
  registerBuiltinTools();
  resetSessionPromotions();

  // Build the real system prompt + tool list (turn 0 context)
  const baselinePrompt = await buildPrompt();

  // Get the prefetched + classified tool list as it would appear at turn 0
  const prefetchCtx = { userInput: '', computerUseEnabled: false, activeSkills: [], turnCount: 0 };
  const all = getAllTools();
  const prefetched = new Set(prefetchTools(prefetchCtx));
  const { coreTools } = classifyTools(all, prefetched);
  console.log(`[setup] core tools: ${coreTools.length}, contains report_plan: ${coreTools.some(t => t.name === 'report_plan')}`);
  console.log(`[setup] prompt length: ${baselinePrompt.length} chars`);

  // Variant A
  const variantAPrompt = baselinePrompt;
  const variantATools = convertTools(coreTools);

  // Variant B
  const variantBPrompt = patchPromptVariantB(baselinePrompt);
  const variantBTools = convertTools(patchToolsVariantB(coreTools));
  const promptDelta = variantBPrompt.length - variantAPrompt.length;
  console.log(`[setup] variant B prompt delta: ${promptDelta} chars`);
  if (Math.abs(promptDelta) < 50) {
    console.warn('[setup] WARNING: variant B prompt is nearly identical — patch may have failed');
  }

  // Anthropic client pointed at MiniMax
  const client = new Anthropic({
    apiKey: API_KEY,
    baseURL: BASE_URL,
    dangerouslyAllowBrowser: true,
  });

  console.log(`\n🔬 A/B test against ${MODEL} @ ${BASE_URL}`);
  console.log(`   Cases: ${CASES.length}`);
  console.log(`   Variants: A (baseline) + B (strengthened)\n`);

  const results: CaseResult[] = [];

  for (const c of CASES) {
    console.log(`\n--- Case: ${c.id} ---`);
    console.log(`Input: ${c.input}`);

    const a = await runOneCase('A', client, variantAPrompt, variantATools, c);
    results.push(a);
    console.log(`  [A baseline]  tools=[${a.toolsCalled.join(', ')}] planFirst=${a.planFirst} ${a.error ? `ERROR: ${a.error.slice(0, 100)}` : ''}`);

    const b = await runOneCase('B', client, variantBPrompt, variantBTools, c);
    results.push(b);
    console.log(`  [B strength]  tools=[${b.toolsCalled.join(', ')}] planFirst=${b.planFirst} ${b.error ? `ERROR: ${b.error.slice(0, 100)}` : ''}`);
  }

  // Summary
  console.log(`\n📊 Summary\n`);
  const aResults = results.filter(r => r.variant === 'A');
  const bResults = results.filter(r => r.variant === 'B');
  const aPlanRate = aResults.filter(r => r.planCalled).length / aResults.length;
  const bPlanRate = bResults.filter(r => r.planCalled).length / bResults.length;
  const aFirstRate = aResults.filter(r => r.planFirst).length / aResults.length;
  const bFirstRate = bResults.filter(r => r.planFirst).length / bResults.length;
  console.log(`  Variant A: plan called in ${aResults.filter(r => r.planCalled).length}/${aResults.length} cases (${Math.round(aPlanRate * 100)}%), plan-first in ${aResults.filter(r => r.planFirst).length}/${aResults.length} (${Math.round(aFirstRate * 100)}%)`);
  console.log(`  Variant B: plan called in ${bResults.filter(r => r.planCalled).length}/${bResults.length} cases (${Math.round(bPlanRate * 100)}%), plan-first in ${bResults.filter(r => r.planFirst).length}/${bResults.length} (${Math.round(bFirstRate * 100)}%)`);

  console.log(`\n--- detail json ---`);
  console.log(JSON.stringify(results, null, 2));
}

main().catch(err => {
  console.error('Eval failed:', err);
  process.exit(1);
});
