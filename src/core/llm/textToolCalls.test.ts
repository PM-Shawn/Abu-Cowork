import { describe, it, expect, vi } from 'vitest';
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
      timeout: { type: ['number', 'null'] },
    },
    required: ['path'],
  },
  execute: async () => 'ok',
}];

function run(chunks: readonly string[], tools: readonly ToolDefinition[] = TOOLS): TextSegment[] {
  const parser = createTextToolCallParser(tools);
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
function parse(text: string, tools: readonly ToolDefinition[] = TOOLS): unknown[] {
  const whole = shape(run([text], tools));
  expect(shape(run([...text], tools))).toEqual(whole);
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

  describe('inline code between single backticks', () => {
    it('shows a marker inside inline code as text', () => {
      const text = '用 `<invoke name="read_file">` 这种写法。';
      expect(parse(text)).toEqual([{ type: 'text', text }]);
    });

    it('still runs a real operation after the inline code closes on the same line', () => {
      const text = '写法是 `<invoke name="x">`，现在执行：<invoke name="read_file"><parameter name="path">a.txt</parameter></invoke>';
      expect(parse(text)).toEqual([
        { type: 'text', text: '写法是 `<invoke name="x">`，现在执行：' },
        { type: 'tool_call', name: 'read_file', input: { path: 'a.txt' } },
      ]);
    });

    it('forgets an unclosed backtick at the end of the line', () => {
      expect(parse('a ` b\n<invoke name="read_file"><parameter name="path">a</parameter></invoke>')).toEqual([
        { type: 'text', text: 'a ` b\n' },
        { type: 'tool_call', name: 'read_file', input: { path: 'a' } },
      ]);
    });

    it('treats everything after a lone triple backtick in prose as code block text', () => {
      const text = 'Use ``` like this <invoke name="read_file"><parameter name="path">a</parameter></invoke>';
      expect(parse(text)).toEqual([{ type: 'text', text }]);
    });
  });

  describe('MiniMax-M2 <minimax:tool_call>', () => {
    it('hides the wrapper and runs every <invoke> inside it', () => {
      const text = 'ok <minimax:tool_call><invoke name="read_file">\n<parameter name="path">a.txt</parameter>\n</invoke><invoke name="read_file">\n<parameter name="path">b.txt</parameter>\n</invoke></minimax:tool_call> done';
      expect(parse(text)).toEqual([
        { type: 'text', text: 'ok ' },
        { type: 'tool_call', name: 'read_file', input: { path: 'a.txt' } },
        { type: 'tool_call', name: 'read_file', input: { path: 'b.txt' } },
        { type: 'text', text: ' done' },
      ]);
    });
  });

  describe('a request without tools', () => {
    it('only splits <think> and shows every other form as text', () => {
      const text = 'see <tool_call>{"name":"read_file","arguments":{"path":"a"}}</tool_call> and <invoke name="read_file"><parameter name="path">a</parameter></invoke> and <function_calls>x';
      expect(parse(`<think>plan</think>${text}`, [])).toEqual([
        { type: 'thinking', thinking: 'plan' },
        { type: 'text', text },
      ]);
    });
  });

  it('scans an open block in linear time when fed one character at a time', () => {
    const text = `<invoke name="read_file"><parameter name="path">${'x'.repeat(4000)}</parameter></invoke>`;
    const originalIndexOf = String.prototype.indexOf;
    let scanned = 0;
    const spy = vi.spyOn(String.prototype, 'indexOf').mockImplementation(function (this: string, search: string, position?: number) {
      if (search === '</invoke>') scanned += this.length - (position ?? 0);
      return originalIndexOf.call(this, search, position);
    });
    let segments: TextSegment[];
    try {
      segments = run([...text]);
    } finally {
      spy.mockRestore();
    }
    expect(segments.filter((s) => s.type === 'tool_call')).toHaveLength(1);
    expect(scanned).toBeLessThan(text.length * 20);
  });

  describe('smaller gaps in the recognised forms', () => {
    it('accepts single-quoted names', () => {
      expect(parse("<invoke name='read_file'><parameter name='path'>a.txt</parameter></invoke>")).toEqual([
        { type: 'tool_call', name: 'read_file', input: { path: 'a.txt' } },
      ]);
    });

    it('accepts a line break or several spaces between <invoke and name=', () => {
      expect(parse('<invoke\n  name="read_file"><parameter name="path">a.txt</parameter></invoke>')).toEqual([
        { type: 'tool_call', name: 'read_file', input: { path: 'a.txt' } },
      ]);
      expect(parse('<invoke    name="read_file"><parameter name="path">a.txt</parameter></invoke>')).toEqual([
        { type: 'tool_call', name: 'read_file', input: { path: 'a.txt' } },
      ]);
    });

    it('leaves a word that only starts with <invoke as text', () => {
      const text = 'I <invoked> it';
      expect(parse(text)).toEqual([{ type: 'text', text }]);
    });

    it('reports <function_calls> as malformed when one of its <invoke> cannot be read', () => {
      const raw = '<function_calls><invoke name="read_file"><parameter name="path">a</parameter></invoke><invoke read_file></invoke></function_calls>';
      expect(parse(raw)).toEqual([{ type: 'malformed', raw }]);
    });

    it('converts by the non-null type when the schema type is a list', () => {
      const text = '<invoke name="read_file"><parameter name="path">a</parameter><parameter name="timeout">30</parameter></invoke><invoke name="read_file"><parameter name="path">b</parameter><parameter name="timeout">none</parameter></invoke>';
      expect(parse(text)).toEqual([
        { type: 'tool_call', name: 'read_file', input: { path: 'a', timeout: 30 } },
        { type: 'tool_call', name: 'read_file', input: { path: 'b', timeout: 'none' } },
      ]);
    });

    it('accepts only decimal whole numbers for an integer', () => {
      const call = (limit: string) => `<invoke name="read_file"><parameter name="path">a</parameter><parameter name="limit">${limit}</parameter></invoke>`;
      expect(parse(call('1.5') + call('0x10') + call('-3'))).toEqual([
        { type: 'tool_call', name: 'read_file', input: { path: 'a', limit: '1.5' } },
        { type: 'tool_call', name: 'read_file', input: { path: 'a', limit: '0x10' } },
        { type: 'tool_call', name: 'read_file', input: { path: 'a', limit: -3 } },
      ]);
    });
  });
});
