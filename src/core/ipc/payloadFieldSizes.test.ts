import { describe, expect, it } from 'vitest';
import { FIELD_BREAKDOWN_MIN_BYTES, MEASURED_RPC_METHODS, measurePayloadFields, utf8ByteLength } from './payloadFieldSizes';

describe('utf8ByteLength', () => {
  it('counts UTF-8 bytes, not UTF-16 units', () => {
    expect(utf8ByteLength('abc')).toBe(3);
    expect(utf8ByteLength('中文')).toBe(6);
    expect(utf8ByteLength('😀')).toBe(4);
    expect(utf8ByteLength('é')).toBe(2);
  });
});

describe('measurePayloadFields', () => {
  it('splits an agent.start snapshot into text, both tool-result copies, tools, prompt and settings', () => {
    const result = 'r'.repeat(10);
    const breakdown = measurePayloadFields({
      runId: 'run-1',
      conversationSnapshot: {
        messages: [
          { role: 'user', content: '你好' },
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }],
            toolCalls: [{ id: 't1', name: 'read', input: {}, result }],
            toolCallsForContext: [{ id: 't1', name: 'read', input: {}, result }],
          },
        ],
      },
      toolList: [{ name: 'read' }],
      orchestration: { systemPromptSections: [{ id: 's', text: 'sys' }] },
      settingsSnapshot: { activeModel: 'm' },
      resolvedCreds: { apiKey: 'sk-must-not-leak' },
    });
    expect(breakdown.fieldMessagesTextBytes).toBe(6 + 2);
    expect(breakdown.fieldToolResultsBytes).toBe(10);
    expect(breakdown.fieldToolContextResultsBytes).toBe(10);
    expect(breakdown.fieldMediaBase64Bytes).toBe(4);
    expect(breakdown.fieldToolListBytes).toBe(JSON.stringify([{ name: 'read' }]).length);
    expect(breakdown.fieldSystemPromptBytes).toBe(JSON.stringify([{ id: 's', text: 'sys' }]).length);
    expect(breakdown.fieldSettingsBytes).toBe(JSON.stringify({ activeModel: 'm' }).length);
    expect(Object.values(breakdown).every((v) => typeof v === 'number')).toBe(true);
    expect(JSON.stringify(breakdown)).not.toContain('sk-must-not-leak');
  });

  it('reads llm.chat and subagent.run shapes', () => {
    const llm = measurePayloadFields({ messages: [{ role: 'user', content: 'hey' }], options: { tools: [{ name: 'x' }], systemPrompt: 'sp' } });
    expect(llm.fieldMessagesTextBytes).toBe(3);
    expect(llm.fieldToolListBytes).toBe(JSON.stringify([{ name: 'x' }]).length);
    expect(llm.fieldSystemPromptBytes).toBe(JSON.stringify('sp').length);
    const sub = measurePayloadFields({ task: 'do', context: 'ctx', parentConversationSummary: 'sum', tools: [], delegatedUserTurn: { content: [{ type: 'image', source: { data: 'BBBBBB' } }] } });
    expect(sub.fieldMessagesTextBytes).toBe(2 + 3 + 3);
    expect(sub.fieldMediaBase64Bytes).toBe(6);
  });

  it('never throws on junk and exposes the constants', () => {
    expect(measurePayloadFields(null).fieldMessagesTextBytes).toBe(0);
    expect(measurePayloadFields('x').fieldToolListBytes).toBe(0);
    expect(FIELD_BREAKDOWN_MIN_BYTES).toBe(1024 * 1024);
    expect([...MEASURED_RPC_METHODS].sort()).toEqual(['agent.run', 'agent.start', 'llm.chat', 'subagent.run']);
  });
});
