/**
 * L2 — Tool Selection Eval Runner
 *
 * Sends each eval case to the LLM for a single turn, collects tool_use events,
 * and judges whether the correct tools were selected.
 *
 * Does NOT execute tools — only evaluates tool selection accuracy.
 *
 * Note: Uses Anthropic SDK directly instead of ClaudeAdapter to avoid
 * Tauri-specific dependencies (tauriFetch) that don't work in Node.js.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { ToolSelectionCase, CaseResult, EvalTarget } from './types';
import { registerBuiltinTools } from '@/core/tools/builtins';
import { getAllTools } from '@/core/tools/registry';
import { buildSystemPromptSections, routeInput } from '@/core/agent/orchestrator';
import { sectionsToString } from '@/core/llm/promptSections';
import type { ToolDefinition } from '@/types';

export interface RunOptions {
  apiKey: string;
  baseUrl?: string;
  temperature?: number;
  enableThinking?: boolean;
  thinkingBudget?: number;
  /** Filter to specific case IDs */
  filter?: string[];
  /** Filter to specific category */
  category?: string;
}

function convertTools(tools: ToolDefinition[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
  }));
}

/**
 * Judge whether tool calls match the expected pattern.
 */
function judgeToolSelection(
  toolsCalled: string[],
  expected: ToolSelectionCase['expected'],
  toolCallDetails: Array<{ name: string; input: Record<string, unknown> }>,
): { passed: boolean; missingTools: string[]; forbiddenToolsCalled: string[]; paramMismatches: string[] } {
  const missingTools = expected.requiredTools.filter(t => !toolsCalled.includes(t));
  const forbiddenToolsCalled = (expected.forbiddenTools ?? []).filter(t => toolsCalled.includes(t));

  const paramMismatches: string[] = [];
  if (expected.toolParams) {
    for (const [toolName, expectedParams] of Object.entries(expected.toolParams)) {
      const call = toolCallDetails.find(tc => tc.name === toolName);
      if (!call) continue;
      for (const [key, value] of Object.entries(expectedParams)) {
        if (value === undefined) continue;
        const actual = String(call.input[key] ?? '');
        const expectedStr = String(value);
        if (!actual.includes(expectedStr)) {
          paramMismatches.push(`${toolName}.${key}: expected contains "${expectedStr}", got "${actual}"`);
        }
      }
    }
  }

  const passed = missingTools.length === 0
    && forbiddenToolsCalled.length === 0
    && paramMismatches.length === 0;

  return { passed, missingTools, forbiddenToolsCalled, paramMismatches };
}

/**
 * Run tool selection eval for a set of cases against a target provider+model.
 */
export async function runToolSelectionEval(
  cases: ToolSelectionCase[],
  target: EvalTarget,
  options: RunOptions,
): Promise<CaseResult[]> {
  // Ensure tools are registered
  registerBuiltinTools();

  // Build system prompt — use imContext to bypass Tauri-dependent code
  const route = routeInput('');
  const evalImContext = { platform: 'eval', workspacePath: '/eval/workspace' };
  const sections = await buildSystemPromptSections(route, '', 'eval-session', evalImContext, 0);
  const systemPrompt = sectionsToString(sections);

  // Get tool definitions for LLM — the real production toolset (Labs-gated
  // tools respect their flag), so the benchmark matches what users actually see.
  const tools = getAllTools();
  const anthropicTools = convertTools(tools);

  // Create Anthropic client directly (bypasses tauriFetch)
  const clientOptions: Record<string, unknown> = {
    apiKey: options.apiKey,
    dangerouslyAllowBrowser: true,
  };
  if (options.baseUrl) {
    clientOptions.baseURL = options.baseUrl;
  }
  const client = new Anthropic(clientOptions as ConstructorParameters<typeof Anthropic>[0]);

  const results: CaseResult[] = [];

  // Apply filters
  let filteredCases = cases;
  if (options.filter?.length) {
    filteredCases = cases.filter(c => options.filter!.includes(c.id));
  }
  if (options.category) {
    filteredCases = filteredCases.filter(c => c.category === options.category);
  }

  for (const evalCase of filteredCases) {
    const start = Date.now();
    const toolCalls: Array<{ name: string; input: Record<string, unknown> }> = [];
    const tokenUsage = { input: 0, output: 0 };
    let thinking = '';
    let error: string | undefined;

    try {
      // Build messages
      const messages: Anthropic.MessageParam[] = [
        ...(evalCase.contextMessages?.map(m => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        })) ?? []),
        { role: 'user' as const, content: evalCase.input },
      ];

      // Build params
      const params: Anthropic.MessageCreateParams = {
        model: target.modelId,
        max_tokens: 4096,
        messages,
        system: systemPrompt,
        tools: anthropicTools,
        stream: true,
      };

      if (options.temperature !== undefined) {
        params.temperature = options.temperature;
      }

      // Stream response — collect tool_use events
      const stream = await client.messages.create(params);

      let currentToolName = '';
      let currentToolInput = '';

      for await (const event of stream as AsyncIterable<Anthropic.MessageStreamEvent>) {
        switch (event.type) {
          case 'content_block_start':
            if (event.content_block.type === 'tool_use') {
              currentToolName = event.content_block.name;
              currentToolInput = '';
            } else if (event.content_block.type === 'thinking') {
              // M2.7 has thinking by default
            }
            break;

          case 'content_block_delta':
            if (event.delta.type === 'input_json_delta') {
              currentToolInput += event.delta.partial_json;
            } else if (event.delta.type === 'thinking_delta') {
              thinking += event.delta.thinking;
            }
            break;

          case 'content_block_stop':
            if (currentToolName) {
              try {
                const input = currentToolInput ? JSON.parse(currentToolInput) : {};
                toolCalls.push({ name: currentToolName, input });
              } catch {
                toolCalls.push({ name: currentToolName, input: {} });
              }
              currentToolName = '';
              currentToolInput = '';
            }
            break;

          case 'message_delta':
            if (event.usage) {
              tokenUsage.output = event.usage.output_tokens;
            }
            break;

          case 'message_start':
            if (event.message.usage) {
              tokenUsage.input = event.message.usage.input_tokens;
            }
            break;
        }
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }

    // Judge
    const toolsCalled = toolCalls.map(tc => tc.name);
    const judgment = error
      ? { passed: false, missingTools: evalCase.expected.requiredTools, forbiddenToolsCalled: [], paramMismatches: [`Error: ${error}`] }
      : judgeToolSelection(toolsCalled, evalCase.expected, toolCalls);

    results.push({
      caseId: evalCase.id,
      target,
      passed: judgment.passed,
      toolsCalled,
      details: {
        missingTools: judgment.missingTools,
        forbiddenToolsCalled: judgment.forbiddenToolsCalled,
        paramMismatches: judgment.paramMismatches,
      },
      latencyMs: Date.now() - start,
      tokenUsage,
      thinking: thinking || undefined,
      error,
    });

    // Log progress
    const status = judgment.passed ? '✅' : '❌';
    console.log(`  ${status} ${evalCase.id} (${Date.now() - start}ms) tools=[${toolsCalled.join(', ')}]`);
  }

  return results;
}
