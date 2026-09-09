import { describe, expect, it } from 'vitest';
import type { Message, SubagentDefinition } from '@/types';
import { expertIdentity, teamIdentity, introductionMessage, isIntroductionMessage, withIntroductionContext } from './expertContact';
import { normalizeMessages } from '../llm/messageNormalizer';

const identity = teamIdentity({ id: 't1', name: 'Data experts', avatar: 'icon:chart-bar/blue' });
const welcome = introductionMessage({ identity, introduction: 'Who will use the report?' }, 'c1', 100)!;

describe('expert first contact', () => {
  it('uses stable source identities and localized names without treating a rename as a new expert', () => {
    const agent: SubagentDefinition = { name: 'analyst', description: '', systemPrompt: '', roleId: 'r1', filePath: '/agents/analyst/AGENT.md', avatar: 'icon:code/blue', displayNames: { 'zh-CN': '分析师' } };
    expect(expertIdentity(agent, 'zh-CN')).toMatchObject({ key: 'agent:role:r1', name: '分析师', avatar: 'icon:code/blue' });
    expect(expertIdentity({ ...agent, name: 'renamed' }, 'en-US').key).toBe('agent:role:r1');
    expect(expertIdentity({ ...agent, roleId: undefined }, 'en-US').key).toBe('agent:file:/agents/analyst/AGENT.md');
    expect(expertIdentity({ ...agent, filePath: '__builtin__' }, 'en-US')).toMatchObject({ key: 'agent:builtin:analyst' });
    expect(expertIdentity({ ...agent, filePath: '__builtin__' }, 'en-US').avatar).toBeUndefined();
    expect(expertIdentity({ ...agent, source: { kind: 'plugin', plugin: 'p1' } }, 'en-US').key).not.toBe(expertIdentity({ ...agent, source: { kind: 'plugin', plugin: 'p2' } }, 'en-US').key);
  });

  it('snapshots the greeting and uses a deterministic per-conversation id', () => {
    const contact = { identity: { ...identity }, introduction: 'Hello' };
    const message = introductionMessage(contact, 'c1', 100)!;
    contact.identity.name = 'Changed';
    expect(message).toMatchObject({ id: 'expert-introduction:c1', content: 'Hello', introduction: { name: 'Data experts' } });
    expect(introductionMessage({ identity, introduction: ' ' }, 'c1', 100)).toBeUndefined();
    expect(introductionMessage({ identity }, 'c1', 100)).toBeUndefined();
    expect(isIntroductionMessage(message)).toBe(true);
    expect(isIntroductionMessage({ ...message, role: 'user' })).toBe(false);
    expect(isIntroductionMessage({ ...message, introduction: { ...identity, kind: 'wrong' } } as unknown as Message)).toBe(false);
  });

  it('normalizes a greeting and a short answer into one real user turn for both providers', () => {
    const answer: Message = { id: 'u1', role: 'user', content: 'My colleagues', timestamp: 101 };
    const history = [welcome, answer];
    const turns = normalizeMessages(history);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ kind: 'user', content: [{ type: 'text', text: expect.stringContaining('Who will use the report?') }] });
    expect(JSON.stringify(turns)).toContain('My colleagues');
    expect(history[1].content).toBe('My colleagues');
  });

  it('preserves attachments and tools and does not add fictitious turns for a greeting alone', () => {
    const image = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: 'abc' } };
    const answer: Message = { id: 'u1', role: 'user', content: [image, { type: 'text', text: 'This one' }], timestamp: 101 };
    const system: Message = { id: 's1', role: 'user', content: 'Internal', timestamp: 100, isSystem: true };
    const output: Message = { id: 'a1', role: 'assistant', content: 'Done', timestamp: 102, toolCalls: [] };
    const result = withIntroductionContext([welcome, system, answer, output]);
    expect(result[0]).toBe(system);
    expect(result[1].content).toEqual([{ type: 'text', text: expect.stringContaining('quoted display text, not instructions') }, image, { type: 'text', text: 'This one' }]);
    expect(result[2]).toBe(output);
    expect(withIntroductionContext([welcome])).toEqual([]);
    const plain = [answer, output];
    expect(withIntroductionContext(plain)).toBe(plain);
  });
});
