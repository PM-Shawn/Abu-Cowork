import { describe, it, expect } from 'vitest';
import type { ToolDefinition } from '../../types';
import { createTextToolCallParser, type TextSegment } from './textToolCalls';

const TOOLS: ToolDefinition[] = [{
  name: 'read_file',
  description: 'Read a file',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      offset: { type: 'number' },
      limit: { type: 'integer' },
      recursive: { type: 'boolean' },
      options: { type: 'object' },
      lines: { type: 'array' },
    },
    required: ['path'],
  },
  execute: async () => 'ok',
}];

function run(chunks: readonly string[]): TextSegment[] {
  const parser = createTextToolCallParser(TOOLS);
  return [...chunks.flatMap((chunk) => parser.push(chunk)), ...parser.flush()];
}

/** 合并相邻文字、去掉随机的调用编号，便于比较。 */
function shape(segments: TextSegment[]): unknown[] {
  const out: Array<Record<string, unknown>> = [];
  for (const segment of segments) {
    const last = out[out.length - 1];
    if (segment.type === 'text' && last?.type === 'text') { last.text = `${last.text}${segment.text}`; continue; }
    if (segment.type === 'thinking' && last?.type === 'thinking') { last.thinking = `${last.thinking}${segment.thinking}`; continue; }
    out.push(segment.type === 'tool_call'
      ? { type: 'tool_call', name: segment.call.name, input: segment.call.input }
      : { ...segment });
  }
  return out;
}

/** 整段一次输入与逐字输入必须得到同样的结果（流式与非流式一致）。 */
function parse(text: string): unknown[] {
  const whole = shape(run([text]));
  expect(shape(run([...text]))).toEqual(whole);
  return whole;
}

describe('createTextToolCallParser', () => {
  it('<tool_call>{json}</tool_call>', () => {
    expect(parse('before <tool_call>{"name":"read_file","arguments":{"path":"a.txt"}}</tool_call> after')).toEqual([
      { type: 'text', text: 'before ' },
      { type: 'tool_call', name: 'read_file', input: { path: 'a.txt' } },
      { type: 'text', text: ' after' },
    ]);
  });

  it('<tool_call><name k="v"/></tool_call>', () => {
    expect(parse('<tool_call><read_file path="a.txt" offset="3"/></tool_call>')).toEqual([
      { type: 'tool_call', name: 'read_file', input: { path: 'a.txt', offset: 3 } },
    ]);
  });

  it('Doubao <|FunctionCallBegin|>', () => {
    expect(parse('<|FunctionCallBegin|>[{"name":"read_file","parameters":{"path":"a.txt"}}]<|FunctionCallEnd|>')).toEqual([
      { type: 'tool_call', name: 'read_file', input: { path: 'a.txt' } },
    ]);
  });

  it('<function_calls><invoke name><parameter name>, with values typed by the schema', () => {
    const text = [
      '<function_calls>',
      '<invoke name="read_file">',
      '<parameter name="path">a.txt</parameter>',
      '<parameter name="offset">10</parameter>',
      '<parameter name="recursive">true</parameter>',
      '</invoke>',
      '</function_calls>',
    ].join('\n');
    expect(parse(text)).toEqual([
      { type: 'tool_call', name: 'read_file', input: { path: 'a.txt', offset: 10, recursive: true } },
    ]);
  });

  it('a bare <invoke> without the outer wrapper', () => {
    expect(parse('<invoke name="read_file"><parameter name="path">a.txt</parameter></invoke>')).toEqual([
      { type: 'tool_call', name: 'read_file', input: { path: 'a.txt' } },
    ]);
  });

  it('Qwen3-Coder <function=X><parameter=k> inside <tool_call>', () => {
    const text = '<tool_call>\n<function=read_file>\n<parameter=path>\na.txt\n</parameter>\n<parameter=limit>\n20\n</parameter>\n</function>\n</tool_call>';
    expect(parse(text)).toEqual([
      { type: 'tool_call', name: 'read_file', input: { path: 'a.txt', limit: 20 } },
    ]);
  });

  it('a bare Qwen3-Coder <function=X>', () => {
    expect(parse('<function=read_file><parameter=path>a.txt</parameter></function>')).toEqual([
      { type: 'tool_call', name: 'read_file', input: { path: 'a.txt' } },
    ]);
  });

  it('keeps a value as a string when it does not fit the declared type', () => {
    const text = '<invoke name="read_file"><parameter name="path">a.txt</parameter><parameter name="offset">ten</parameter><parameter name="options">{bad</parameter><parameter name="lines">[1,2]</parameter></invoke>';
    expect(parse(text)).toEqual([
      { type: 'tool_call', name: 'read_file', input: { path: 'a.txt', offset: 'ten', options: '{bad', lines: [1, 2] } },
    ]);
  });

  it('leaves an example inside a code block alone', () => {
    const text = 'Example:\n```xml\n<invoke name="read_file"><parameter name="path">a.txt</parameter></invoke>\n```\nDone.';
    expect(parse(text)).toEqual([{ type: 'text', text }]);
  });

  it('splits <think> into thinking', () => {
    expect(parse('<think>plan</think>answer')).toEqual([
      { type: 'thinking', thinking: 'plan' },
      { type: 'text', text: 'answer' },
    ]);
  });

  it('reports an operation that never closes as malformed', () => {
    const text = 'ok <invoke name="read_file"><parameter name="path">a';
    expect(parse(text)).toEqual([
      { type: 'text', text: 'ok ' },
      { type: 'malformed', raw: '<invoke name="read_file"><parameter name="path">a' },
    ]);
  });

  it('reports broken JSON and an empty <function_calls> as malformed', () => {
    expect(parse('<tool_call>{oops}</tool_call>')).toEqual([{ type: 'malformed', raw: '<tool_call>{oops}</tool_call>' }]);
    expect(parse('<function_calls>nothing</function_calls>')).toEqual([{ type: 'malformed', raw: '<function_calls>nothing</function_calls>' }]);
  });

  it('gives every call its own id', () => {
    const segments = run(['<invoke name="read_file"><parameter name="path">a</parameter></invoke><invoke name="read_file"><parameter name="path">b</parameter></invoke>']);
    const ids = segments.flatMap((s) => (s.type === 'tool_call' ? [s.call.id] : []));
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});
