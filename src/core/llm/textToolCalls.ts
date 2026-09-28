import type { ToolDefinition } from '../../types';

export interface TextToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type TextSegment =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_call'; call: TextToolCall }
  | { type: 'malformed'; raw: string };

export interface TextToolCallParser {
  push(chunk: string): TextSegment[];
  flush(): TextSegment[];
}

type BlockKind = 'think' | 'tool_call' | 'doubao' | 'function_calls' | 'invoke' | 'function';

interface BlockSyntax {
  kind: BlockKind;
  open: string;
  close: string;
}

const BLOCKS: readonly BlockSyntax[] = [
  { kind: 'think', open: '<think>', close: '</think>' },
  { kind: 'tool_call', open: '<tool_call>', close: '</tool_call>' },
  { kind: 'doubao', open: '<|FunctionCallBegin|>', close: '<|FunctionCallEnd|>' },
  { kind: 'function_calls', open: '<function_calls>', close: '</function_calls>' },
  { kind: 'invoke', open: '<invoke ', close: '</invoke>' },
  { kind: 'function', open: '<function=', close: '</function>' },
];

const FENCE = '```';
const OPENERS: readonly string[] = [FENCE, ...BLOCKS.map((block) => block.open)];

const INVOKE = /<invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/invoke>/g;
const INVOKE_PARAMETER = /<parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/parameter>/g;
const QWEN_FUNCTION = /^<function=([^>\s]+)>([\s\S]*)<\/function>$/;
const QWEN_PARAMETER = /<parameter=([^>\s]+)>([\s\S]*?)<\/parameter>/g;
const XML_ATTRIBUTES = /^<([a-zA-Z_][a-zA-Z0-9_-]*)(\s[^>]*)?\s*\/?>$/;
const XML_ATTRIBUTE = /([a-zA-Z_][a-zA-Z0-9_]*)="([^"]*)"/g;

let textToolCallCounter = 0;
function nextTextToolCallId(): string {
  textToolCallCounter += 1;
  return `text-tc-${Date.now().toString(36)}-${textToolCallCounter.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 模型写的 JSON 解析不了就返回 null，由调用方报告写坏。 */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 文字结尾有多长可能是某个标记的开头，这部分先留着等下一段。 */
function heldSuffixLength(text: string, tokens: readonly string[]): number {
  let longest = 0;
  for (const token of tokens) {
    for (let length = Math.min(text.length, token.length - 1); length > longest; length--) {
      if (text.endsWith(token.slice(0, length))) {
        longest = length;
        break;
      }
    }
  }
  return longest;
}

function earliestOpener(text: string): { index: number; token: string; block?: BlockSyntax } | null {
  let best: { index: number; token: string; block?: BlockSyntax } | null = null;
  const fence = text.indexOf(FENCE);
  if (fence >= 0) best = { index: fence, token: FENCE };
  for (const block of BLOCKS) {
    const index = text.indexOf(block.open);
    if (index >= 0 && (best === null || index < best.index)) best = { index, token: block.open, block };
  }
  return best;
}

function schemaProperties(tools: readonly ToolDefinition[], name: string): Record<string, unknown> {
  const properties: unknown = tools.find((tool) => tool.name === name)?.inputSchema.properties;
  return isRecord(properties) ? properties : {};
}

/** 参数写法里的值都是文字，按工具的 inputSchema 转类型；转不了保留文字。 */
function coerceValue(value: string, schema: unknown): unknown {
  const type = isRecord(schema) ? schema.type : undefined;
  const trimmed = value.trim();
  if (type === 'number' || type === 'integer') {
    const parsed = Number(trimmed);
    return trimmed !== '' && Number.isFinite(parsed) ? parsed : value;
  }
  if (type === 'boolean') {
    if (trimmed.toLowerCase() === 'true') return true;
    if (trimmed.toLowerCase() === 'false') return false;
    return value;
  }
  if (type === 'object' || type === 'array') {
    const parsed = parseJson(trimmed);
    const fits = type === 'array' ? Array.isArray(parsed) : isRecord(parsed);
    return fits ? parsed : value;
  }
  return value;
}

/** 值前后各去掉一个换行：Qwen3-Coder 与 invoke 写法常把值放在单独一行。 */
function unwrapValue(value: string): string {
  return value.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
}

function callFromParameters(
  name: string,
  parameters: ReadonlyArray<readonly [string, string]>,
  tools: readonly ToolDefinition[],
): TextToolCall {
  const properties = schemaProperties(tools, name);
  const input: Record<string, unknown> = {};
  for (const [key, raw] of parameters) input[key] = coerceValue(unwrapValue(raw), properties[key]);
  return { id: nextTextToolCallId(), name, input };
}

function callFromJson(value: unknown): TextToolCall | null {
  if (!isRecord(value) || typeof value.name !== 'string' || !value.name) return null;
  const args = value.arguments ?? value.parameters ?? {};
  const input = typeof args === 'string' ? parseJson(args) : args;
  return isRecord(input) ? { id: nextTextToolCallId(), name: value.name, input } : null;
}

function invokeCalls(text: string, tools: readonly ToolDefinition[]): TextToolCall[] {
  return [...text.matchAll(INVOKE)].map(([, name, body]) =>
    callFromParameters(name, [...body.matchAll(INVOKE_PARAMETER)].map(([, key, value]) => [key, value] as const), tools));
}

function qwenCall(text: string, tools: readonly ToolDefinition[]): TextToolCall | null {
  const match = QWEN_FUNCTION.exec(text.trim());
  if (!match) return null;
  return callFromParameters(match[1], [...match[2].matchAll(QWEN_PARAMETER)].map(([, key, value]) => [key, value] as const), tools);
}

function parseBlock(
  kind: Exclude<BlockKind, 'think'>,
  raw: string,
  inner: string,
  tools: readonly ToolDefinition[],
): TextToolCall[] | null {
  const body = inner.trim();
  switch (kind) {
    case 'tool_call': {
      if (body.startsWith('{')) {
        const call = callFromJson(parseJson(body));
        return call ? [call] : null;
      }
      if (body.startsWith('<function=')) {
        const call = qwenCall(body, tools);
        return call ? [call] : null;
      }
      const xml = XML_ATTRIBUTES.exec(body);
      if (!xml) return null;
      return [callFromParameters(xml[1], [...(xml[2] ?? '').matchAll(XML_ATTRIBUTE)].map(([, key, value]) => [key, value] as const), tools)];
    }
    case 'doubao': {
      const parsed = parseJson(body);
      const calls = (Array.isArray(parsed) ? parsed : [parsed]).map(callFromJson);
      return calls.length > 0 && calls.every((call): call is TextToolCall => call !== null) ? calls : null;
    }
    case 'function_calls': {
      const calls = invokeCalls(body, tools);
      return calls.length > 0 ? calls : null;
    }
    case 'invoke': {
      const calls = invokeCalls(raw, tools);
      return calls.length === 1 ? calls : null;
    }
    case 'function': {
      const call = qwenCall(raw, tools);
      return call ? [call] : null;
    }
  }
}

/**
 * 边接收边识别正文里的操作。识别出的片段不作为文字输出；
 * 三个反引号的代码块里的内容原样作为文字，不识别。
 */
export function createTextToolCallParser(tools: readonly ToolDefinition[]): TextToolCallParser {
  let pending = '';
  let mode: 'text' | 'fence' | BlockSyntax = 'text';

  const closeBlock = (block: BlockSyntax, inner: string, out: TextSegment[]): void => {
    if (block.kind === 'think') {
      if (inner) out.push({ type: 'thinking', thinking: inner });
      return;
    }
    const raw = block.open + inner + block.close;
    const calls = parseBlock(block.kind, raw, inner, tools);
    if (calls === null) {
      out.push({ type: 'malformed', raw });
      return;
    }
    for (const call of calls) out.push({ type: 'tool_call', call });
  };

  const drain = (out: TextSegment[]): void => {
    while (pending) {
      if (mode === 'fence') {
        const end = pending.indexOf(FENCE);
        if (end >= 0) {
          out.push({ type: 'text', text: pending.slice(0, end + FENCE.length) });
          pending = pending.slice(end + FENCE.length);
          mode = 'text';
          continue;
        }
        const safe = pending.length - heldSuffixLength(pending, [FENCE]);
        if (safe > 0) out.push({ type: 'text', text: pending.slice(0, safe) });
        pending = pending.slice(safe);
        return;
      }
      if (mode !== 'text') {
        const block: BlockSyntax = mode;
        const end = pending.indexOf(block.close);
        if (end >= 0) {
          const inner = pending.slice(0, end);
          pending = pending.slice(end + block.close.length);
          mode = 'text';
          closeBlock(block, inner, out);
          continue;
        }
        if (block.kind === 'think') {
          const safe = pending.length - heldSuffixLength(pending, [block.close]);
          if (safe > 0) out.push({ type: 'thinking', thinking: pending.slice(0, safe) });
          pending = pending.slice(safe);
        }
        return;
      }
      const next = earliestOpener(pending);
      if (next) {
        if (next.index > 0) out.push({ type: 'text', text: pending.slice(0, next.index) });
        pending = pending.slice(next.index + next.token.length);
        if (next.block) {
          mode = next.block;
        } else {
          out.push({ type: 'text', text: FENCE });
          mode = 'fence';
        }
        continue;
      }
      const safe = pending.length - heldSuffixLength(pending, OPENERS);
      if (safe > 0) out.push({ type: 'text', text: pending.slice(0, safe) });
      pending = pending.slice(safe);
      return;
    }
  };

  return {
    push(chunk: string): TextSegment[] {
      pending += chunk;
      const out: TextSegment[] = [];
      drain(out);
      return out;
    },
    flush(): TextSegment[] {
      const out: TextSegment[] = [];
      if (mode === 'text' || mode === 'fence') {
        if (pending) out.push({ type: 'text', text: pending });
      } else if (mode.kind === 'think') {
        if (pending) out.push({ type: 'thinking', thinking: pending });
      } else {
        out.push({ type: 'malformed', raw: mode.open + pending });
      }
      pending = '';
      mode = 'text';
      return out;
    },
  };
}
