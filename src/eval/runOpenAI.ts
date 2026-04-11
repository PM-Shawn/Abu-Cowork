#!/usr/bin/env tsx
/**
 * Standalone OpenAI-protocol eval runner.
 *
 * Mirrors toolSelectionRunner.ts but uses native fetch + OpenAI Chat Completions API
 * instead of Anthropic SDK. Created as a one-off to validate V1 hypothesis with
 * non-Anthropic providers (DiDi internal proxy / GLM / etc.) without touching
 * prod LLMAdapter or tauriFetch.
 *
 * Usage:
 *   npx tsx src/eval/runOpenAI.ts \
 *     --base-url http://llm-proxy.intra.xiaojukeji.com \
 *     --api-key sk-xxx \
 *     --model glm-5-external \
 *     --filter local-discovery-smartwork,...
 *
 * NOT wired into run.ts. Standalone. Safe to delete after validation.
 */

import './shimTauri';

import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolSelectionCase } from './types';
import { registerBuiltinTools } from '@/core/tools/builtins';
import { toolRegistry } from '@/core/tools/registry';
import { buildSystemPromptSections, routeInput } from '@/core/agent/orchestrator';
import { sectionsToString } from '@/core/llm/promptSections';
import type { ToolDefinition } from '@/types';

const { values } = parseArgs({
  options: {
    'base-url': { type: 'string' },
    'api-key':  { type: 'string' },
    model:      { type: 'string' },
    filter:     { type: 'string' },
    timeout:    { type: 'string', default: '60' },
  },
});

const baseUrl = values['base-url'];
const apiKey = values['api-key'];
const model = values.model;
const filterIds = values.filter?.split(',').map(s => s.trim()) ?? [];
const timeoutMs = Number(values.timeout) * 1000;

if (!baseUrl || !apiKey || !model) {
  console.error('Usage: tsx src/eval/runOpenAI.ts --base-url <url> --api-key <key> --model <id> [--filter id1,id2,...]');
  process.exit(1);
}

// OpenAI tool format
interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OpenAIToolCall {
  id?: string;
  type?: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAIResponse {
  choices?: Array<{
    message?: {
      role?: string;
      content?: string | null;
      tool_calls?: OpenAIToolCall[];
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  error?: { message?: string; code?: string };
}

function convertToolsToOpenAI(tools: ToolDefinition[]): OpenAITool[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema as Record<string, unknown>,
    },
  }));
}

function judge(
  toolsCalled: string[],
  expected: ToolSelectionCase['expected'],
): { passed: boolean; missingTools: string[]; forbiddenToolsCalled: string[] } {
  const missingTools = expected.requiredTools.filter(t => !toolsCalled.includes(t));
  const forbiddenToolsCalled = (expected.forbiddenTools ?? []).filter(t => toolsCalled.includes(t));
  return {
    passed: missingTools.length === 0 && forbiddenToolsCalled.length === 0,
    missingTools,
    forbiddenToolsCalled,
  };
}

async function callLLM(
  systemPrompt: string,
  userInput: string,
  tools: OpenAITool[],
): Promise<{ toolCalls: OpenAIToolCall[]; content: string; usage?: { prompt_tokens?: number; completion_tokens?: number }; raw?: unknown }> {
  const url = `${baseUrl!.replace(/\/$/, '')}/v1/chat/completions`;
  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userInput },
    ],
    tools,
    tool_choice: 'auto',
    temperature: 0,
    max_tokens: 4096,
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    }

    const data = (await res.json()) as OpenAIResponse;
    if (data.error) {
      throw new Error(`API error: ${data.error.message ?? JSON.stringify(data.error)}`);
    }
    const msg = data.choices?.[0]?.message;
    return {
      toolCalls: msg?.tool_calls ?? [],
      content: msg?.content ?? '',
      usage: data.usage,
      raw: data,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  registerBuiltinTools();

  // Build system prompt the SAME way prod does
  const route = routeInput('');
  const evalImContext = { platform: 'eval', workspacePath: '/eval/workspace' };
  const sections = await buildSystemPromptSections(route, '', 'eval-session', evalImContext, 0);
  const systemPrompt = sectionsToString(sections);

  const tools = toolRegistry.getAll();
  const openaiTools = convertToolsToOpenAI(tools);

  // Load cases
  const datasetPath = join(process.cwd(), 'src/eval/datasets/tool-selection.json');
  const allCases: ToolSelectionCase[] = JSON.parse(readFileSync(datasetPath, 'utf-8'));
  const cases = filterIds.length > 0
    ? allCases.filter(c => filterIds.includes(c.id))
    : allCases;

  if (cases.length === 0) {
    console.error('No cases matched filter.');
    process.exit(1);
  }

  console.log(`\n🔍 Tool-selection eval (OpenAI protocol)`);
  console.log(`   Endpoint: ${baseUrl}`);
  console.log(`   Model:    ${model}`);
  console.log(`   Tools:    ${tools.length} registered`);
  console.log(`   Cases:    ${cases.length}\n`);

  let pass = 0;
  const results: Array<{
    id: string;
    passed: boolean;
    toolsCalled: string[];
    missing: string[];
    forbidden: string[];
    latencyMs: number;
    error?: string;
    content?: string;
  }> = [];

  for (const c of cases) {
    const start = Date.now();
    let toolsCalled: string[] = [];
    let content = '';
    let error: string | undefined;

    try {
      const r = await callLLM(systemPrompt, c.input, openaiTools);
      toolsCalled = r.toolCalls.map(tc => tc.function.name);
      content = r.content;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }

    const j = judge(toolsCalled, c.expected);
    const latencyMs = Date.now() - start;
    if (j.passed) pass++;

    const status = error ? '⚠️ ' : (j.passed ? '✅' : '❌');
    console.log(`  ${status} ${c.id} (${latencyMs}ms) tools=[${toolsCalled.join(', ')}]${error ? ` ERROR: ${error}` : ''}`);
    if (!j.passed && !error) {
      if (j.missingTools.length) console.log(`       missing: ${j.missingTools.join(', ')}`);
      if (j.forbiddenToolsCalled.length) console.log(`       forbidden called: ${j.forbiddenToolsCalled.join(', ')}`);
    }

    results.push({
      id: c.id,
      passed: j.passed,
      toolsCalled,
      missing: j.missingTools,
      forbidden: j.forbiddenToolsCalled,
      latencyMs,
      error,
      content: content.slice(0, 200),
    });
  }

  console.log(`\n📊 Summary: ${pass}/${cases.length} passed (${Math.round(pass / cases.length * 100)}%)\n`);

  // Per-case detail JSON for downstream analysis
  console.log('--- detail json ---');
  console.log(JSON.stringify(results, null, 2));
}

main().catch(err => {
  console.error('Eval failed:', err);
  process.exit(1);
});
