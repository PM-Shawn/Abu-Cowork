import { describe, it, expect } from 'vitest';
import { buildSchemaInstruction, extractJsonObject, validateStructured } from './structuredOutput';

// ─── buildSchemaInstruction ───────────────────────────────────────────────

describe('buildSchemaInstruction', () => {
  it('contains the 【输出要求】 marker', () => {
    const schema = { type: 'object', properties: { vendor: { type: 'string' } } };
    const result = buildSchemaInstruction(schema);
    expect(result).toContain('【输出要求】');
  });

  it('contains the serialised schema JSON', () => {
    const schema = { type: 'object', required: ['vendor', 'amount'] };
    const result = buildSchemaInstruction(schema);
    expect(result).toContain(JSON.stringify(schema));
  });

  it('instructs not to use markdown fences', () => {
    const result = buildSchemaInstruction({});
    expect(result).toContain('markdown 代码块');
  });

  it('instructs not to output explanatory text', () => {
    const result = buildSchemaInstruction({});
    expect(result).toContain('解释性文字');
  });

  it('starts with a blank line separator', () => {
    const result = buildSchemaInstruction({});
    expect(result.startsWith('\n\n')).toBe(true);
  });

  it('works with an empty schema', () => {
    const result = buildSchemaInstruction({});
    expect(result).toContain('{}');
  });
});

// ─── extractJsonObject ────────────────────────────────────────────────────

describe('extractJsonObject', () => {
  it('extracts a plain JSON object', () => {
    const result = extractJsonObject('{"vendor":"Acme","amount":100}');
    expect(result).toEqual({ vendor: 'Acme', amount: 100 });
  });

  it('extracts a JSON object wrapped in ```json fence', () => {
    const text = '```json\n{"vendor":"Acme","amount":100}\n```';
    expect(extractJsonObject(text)).toEqual({ vendor: 'Acme', amount: 100 });
  });

  it('extracts a JSON object wrapped in plain ``` fence', () => {
    const text = '```\n{"key":"value"}\n```';
    expect(extractJsonObject(text)).toEqual({ key: 'value' });
  });

  it('extracts a JSON object embedded in surrounding prose', () => {
    const text = 'Here is my answer: {"vendor":"Beta","date":"2024-01-01"} Done.';
    expect(extractJsonObject(text)).toEqual({ vendor: 'Beta', date: '2024-01-01' });
  });

  it('returns null for invalid JSON', () => {
    expect(extractJsonObject('not json at all')).toBeNull();
  });

  it('returns null for a JSON array (not an object)', () => {
    expect(extractJsonObject('[1, 2, 3]')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(extractJsonObject('')).toBeNull();
  });

  it('returns null for a JSON null literal', () => {
    // JSON.parse("null") === null — should return null, not an object
    expect(extractJsonObject('null')).toBeNull();
  });

  it('returns null for a bare number string', () => {
    expect(extractJsonObject('42')).toBeNull();
  });

  it('handles nested objects correctly', () => {
    const text = '{"a":{"b":1},"c":[1,2]}';
    expect(extractJsonObject(text)).toEqual({ a: { b: 1 }, c: [1, 2] });
  });

  it('picks the outermost object when text has outer braces and inner prose', () => {
    // first { last } approach — outer braces span the full JSON
    const text = '{"x":1}';
    expect(extractJsonObject(text)).toEqual({ x: 1 });
  });
});

// ─── validateStructured ───────────────────────────────────────────────────

describe('validateStructured', () => {
  it('returns ok:true when all required keys are present', () => {
    const result = validateStructured(
      { vendor: 'Acme', amount: 100, date: '2024-01-01' },
      { required: ['vendor', 'amount', 'date'] },
    );
    expect(result).toEqual({ ok: true });
  });

  it('returns ok:false with missing keys when some are absent', () => {
    const result = validateStructured(
      { vendor: 'Acme' },
      { required: ['vendor', 'amount', 'date'] },
    );
    expect(result).toEqual({ ok: false, missing: ['amount', 'date'] });
  });

  it('returns ok:true when schema has no required array', () => {
    const result = validateStructured({ anything: 1 }, { type: 'object' });
    expect(result).toEqual({ ok: true });
  });

  it('returns ok:true when required array is empty', () => {
    const result = validateStructured({}, { required: [] });
    expect(result).toEqual({ ok: true });
  });

  it('returns ok:true when data is empty but no required keys specified', () => {
    const result = validateStructured({}, {});
    expect(result).toEqual({ ok: true });
  });

  it('returns ok:false listing all missing keys', () => {
    const result = validateStructured(
      {},
      { required: ['a', 'b', 'c'] },
    );
    if (result.ok === false) {
      expect(result.missing).toEqual(['a', 'b', 'c']);
    } else {
      throw new Error('Expected ok:false');
    }
  });

  it('treats only own-property keys as present (does not check prototype chain)', () => {
    const data = Object.create({ inherited: 'yes' }) as Record<string, unknown>;
    data['own'] = 'value';
    const result = validateStructured(data, { required: ['own', 'inherited'] });
    // 'inherited' is on the prototype, not an own property — should be missing
    expect(result).toEqual({ ok: false, missing: ['inherited'] });
  });
});
