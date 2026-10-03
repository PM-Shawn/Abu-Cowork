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

type BlockKind = 'think' | 'tool_call' | 'doubao' | 'function_calls' | 'minimax_tool_call' | 'invoke' | 'function';

interface BlockSyntax {
  kind: BlockKind;
  open: string;
  close: string;
  /** 起始标记后面必须紧跟一个空白字符（空格或换行都算），例如 `<invoke name=…>` */
  openNeedsSpace?: boolean;
}

const BLOCKS: readonly BlockSyntax[] = [
  { kind: 'think', open: '<think>', close: '</think>' },
  { kind: 'tool_call', open: '<tool_call>', close: '</tool_call>' },
  { kind: 'doubao', open: '<|FunctionCallBegin|>', close: '<|FunctionCallEnd|>' },
  { kind: 'function_calls', open: '<function_calls>', close: '</function_calls>' },
  { kind: 'minimax_tool_call', open: '<minimax:tool_call>', close: '</minimax:tool_call>' },
  { kind: 'invoke', open: '<invoke', close: '</invoke>', openNeedsSpace: true },
  { kind: 'function', open: '<function=', close: '</function>' },
];

/** 请求里没有工具时只拆分 <think>，其余写法都按文字显示。 */
const THINK_ONLY: readonly BlockSyntax[] = BLOCKS.filter((block) => block.kind === 'think');

const FENCE = '```';

const INVOKE = /<invoke\s+name\s*=\s*(?:"([^"]+)"|'([^']+)')\s*>([\s\S]*?)<\/invoke>/g;
const INVOKE_START = /<invoke\s/g;
const INVOKE_PARAMETER = /<parameter\s+name\s*=\s*(?:"([^"]+)"|'([^']+)')\s*>([\s\S]*?)<\/parameter>/g;
const QWEN_FUNCTION = /^<function=([^>\s]+)>([\s\S]*)<\/function>$/;
const QWEN_PARAMETER = /<parameter=([^>\s]+)>([\s\S]*?)<\/parameter>/g;
const XML_ATTRIBUTES = /^<([a-zA-Z_][a-zA-Z0-9_-]*)(\s[^>]*)?\s*\/?>$/;
const XML_ATTRIBUTE = /([a-zA-Z_][a-zA-Z0-9_]*)="([^"]*)"/g;
const DECIMAL_INTEGER = /^[+-]?\d+$/;

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

/** 需要跟空白的起始标记，按「标记 + 空格」判断结尾是否要先留着。 */
function holdToken(block: BlockSyntax): string {
  return block.openNeedsSpace ? `${block.open} ` : block.open;
}

/** 在 index 处是否是这种块的起始标记；是则返回整个标记的长度，否则返回 0。 */
function openerLengthAt(text: string, index: number, block: BlockSyntax): number {
  if (!text.startsWith(block.open, index)) return 0;
  if (!block.openNeedsSpace) return block.open.length;
  const next = text.charAt(index + block.open.length);
  return next !== '' && /\s/.test(next) ? block.open.length + 1 : 0;
}

interface Opener {
  index: number;
  text: string;
  block?: BlockSyntax;
}

/**
 * 找第一个起始标记。单个反引号围起来的行内代码里的块标记当作文字；
 * 三个反引号不计入单个反引号的个数，遇到换行时行内代码结束。
 */
function findOpener(text: string, inInlineCode: boolean, blocks: readonly BlockSyntax[]): Opener | null {
  let inline = inInlineCode;
  for (let index = 0; index < text.length; index++) {
    if (text.startsWith(FENCE, index)) return { index, text: FENCE };
    if (!inline) {
      for (const block of blocks) {
        const length = openerLengthAt(text, index, block);
        if (length > 0) return { index, text: text.slice(index, index + length), block };
      }
    }
    const char = text[index];
    if (char === '`') inline = !inline;
    else if (char === '\n') inline = false;
  }
  return null;
}

/** 输出这段文字之后，是否还处在行内代码里。 */
function inlineCodeAfter(text: string, inInlineCode: boolean): boolean {
  let inline = inInlineCode;
  for (let index = 0; index < text.length; index++) {
    if (text.startsWith(FENCE, index)) {
      index += FENCE.length - 1;
      continue;
    }
    const char = text[index];
    if (char === '`') inline = !inline;
    else if (char === '\n') inline = false;
  }
  return inline;
}

function schemaProperties(tools: readonly ToolDefinition[], name: string): Record<string, unknown> {
  const properties: unknown = tools.find((tool) => tool.name === name)?.inputSchema.properties;
  return isRecord(properties) ? properties : {};
}

const NOT_CONVERTED = Symbol('not converted');

function convertAs(value: string, type: unknown): unknown {
  const trimmed = value.trim();
  if (type === 'integer') {
    return DECIMAL_INTEGER.test(trimmed) ? Number(trimmed) : NOT_CONVERTED;
  }
  if (type === 'number') {
    const parsed = Number(trimmed);
    return trimmed !== '' && Number.isFinite(parsed) ? parsed : NOT_CONVERTED;
  }
  if (type === 'boolean') {
    if (trimmed.toLowerCase() === 'true') return true;
    if (trimmed.toLowerCase() === 'false') return false;
    return NOT_CONVERTED;
  }
  if (type === 'object' || type === 'array') {
    const parsed = parseJson(trimmed);
    const fits = type === 'array' ? Array.isArray(parsed) : isRecord(parsed);
    return fits ? parsed : NOT_CONVERTED;
  }
  return value;
}

/**
 * 参数写法里的值都是文字，按工具的 inputSchema 转类型；转不了保留文字。
 * `type` 写成数组（例如 ['number', 'null']）时依次尝试其中的非 null 类型。
 */
function coerceValue(value: string, schema: unknown): unknown {
  const declared = isRecord(schema) ? schema.type : undefined;
  const types = (Array.isArray(declared) ? declared : [declared]).filter((type) => type !== 'null');
  for (const type of types) {
    const converted = convertAs(value, type);
    if (converted !== NOT_CONVERTED) return converted;
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

/** 名字可能用双引号或单引号，正则里分成两个分组。 */
function quotedName(doubleQuoted: string | undefined, singleQuoted: string | undefined): string {
  return doubleQuoted ?? singleQuoted ?? '';
}

function invokeCalls(text: string, tools: readonly ToolDefinition[]): TextToolCall[] {
  return [...text.matchAll(INVOKE)].map(([, nameDq, nameSq, body]) =>
    callFromParameters(
      quotedName(nameDq, nameSq),
      [...body.matchAll(INVOKE_PARAMETER)].map(([, keyDq, keySq, value]) => [quotedName(keyDq, keySq), value] as const),
      tools,
    ));
}

/** 外层标签里的每个 <invoke 都要识别出来，有一个识别不出就整块报告写坏。 */
function wrappedInvokeCalls(text: string, tools: readonly ToolDefinition[]): TextToolCall[] | null {
  const calls = invokeCalls(text, tools);
  const opened = [...text.matchAll(INVOKE_START)].length;
  return calls.length > 0 && calls.length === opened ? calls : null;
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
    case 'function_calls':
    case 'minimax_tool_call':
      return wrappedInvokeCalls(body, tools);
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

type ParserMode =
  | { kind: 'text' }
  | { kind: 'fence' }
  | { kind: 'block'; block: BlockSyntax; opener: string };

/**
 * 边接收边识别正文里的操作。识别出的片段不作为文字输出；
 * 三个反引号的代码块与单个反引号的行内代码里的内容原样作为文字，不识别。
 */
export function createTextToolCallParser(tools: readonly ToolDefinition[]): TextToolCallParser {
  const blocks = tools.length > 0 ? BLOCKS : THINK_ONLY;
  const holdTokens: readonly string[] = [FENCE, ...blocks.map(holdToken)];
  let pending = '';
  let mode: ParserMode = { kind: 'text' };
  let inInlineCode = false;
  /** 块内查找结束标记时从这里开始，前面已经确认没有结束标记 */
  let closeSearchFrom = 0;

  const closeBlock = (block: BlockSyntax, opener: string, inner: string, out: TextSegment[]): void => {
    if (block.kind === 'think') {
      if (inner) out.push({ type: 'thinking', thinking: inner });
      return;
    }
    const raw = opener + inner + block.close;
    const calls = parseBlock(block.kind, raw, inner, tools);
    if (calls === null) {
      out.push({ type: 'malformed', raw });
      return;
    }
    for (const call of calls) out.push({ type: 'tool_call', call });
  };

  const drain = (out: TextSegment[]): void => {
    while (pending) {
      if (mode.kind === 'fence') {
        const end = pending.indexOf(FENCE);
        if (end >= 0) {
          out.push({ type: 'text', text: pending.slice(0, end + FENCE.length) });
          pending = pending.slice(end + FENCE.length);
          mode = { kind: 'text' };
          inInlineCode = false;
          continue;
        }
        const safe = pending.length - heldSuffixLength(pending, [FENCE]);
        if (safe > 0) out.push({ type: 'text', text: pending.slice(0, safe) });
        pending = pending.slice(safe);
        return;
      }
      if (mode.kind === 'block') {
        const { block, opener } = mode;
        const end = pending.indexOf(block.close, closeSearchFrom);
        if (end >= 0) {
          const inner = pending.slice(0, end);
          pending = pending.slice(end + block.close.length);
          mode = { kind: 'text' };
          closeSearchFrom = 0;
          closeBlock(block, opener, inner, out);
          continue;
        }
        if (block.kind === 'think') {
          const safe = pending.length - heldSuffixLength(pending, [block.close]);
          if (safe > 0) out.push({ type: 'thinking', thinking: pending.slice(0, safe) });
          pending = pending.slice(safe);
          closeSearchFrom = 0;
        } else {
          closeSearchFrom = Math.max(0, pending.length - block.close.length + 1);
        }
        return;
      }
      const next = findOpener(pending, inInlineCode, blocks);
      if (next) {
        const before = pending.slice(0, next.index);
        if (before) out.push({ type: 'text', text: before });
        inInlineCode = inlineCodeAfter(before, inInlineCode);
        pending = pending.slice(next.index + next.text.length);
        if (next.block) {
          mode = { kind: 'block', block: next.block, opener: next.text };
          closeSearchFrom = 0;
        } else {
          out.push({ type: 'text', text: FENCE });
          mode = { kind: 'fence' };
          inInlineCode = false;
        }
        continue;
      }
      const safe = pending.length - heldSuffixLength(pending, holdTokens);
      if (safe > 0) {
        const text = pending.slice(0, safe);
        out.push({ type: 'text', text });
        inInlineCode = inlineCodeAfter(text, inInlineCode);
      }
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
      if (mode.kind === 'text' || mode.kind === 'fence') {
        if (pending) out.push({ type: 'text', text: pending });
      } else if (mode.block.kind === 'think') {
        if (pending) out.push({ type: 'thinking', thinking: pending });
      } else {
        out.push({ type: 'malformed', raw: mode.opener + pending });
      }
      pending = '';
      mode = { kind: 'text' };
      inInlineCode = false;
      closeSearchFrom = 0;
      return out;
    },
  };
}
