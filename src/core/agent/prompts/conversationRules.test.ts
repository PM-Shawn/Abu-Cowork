import { describe, expect, it } from 'vitest';
import { ASK_BEFORE_GUESSING, buildConversationRuleSections } from './conversationRules';
import { getDefaultSoul } from './defaultSoul';
import { DEFAULT_PLANNING } from './variants/default';
import { gptVariant } from './variants/gpt';
import { getCapabilityPrompt } from './capabilityPrompt';

describe('buildConversationRuleSections', () => {
  it('always carries the ask rule and the writing rules, cacheable', () => {
    const sections = buildConversationRuleSections({ unattended: false });
    expect(sections.map((s) => s.name)).toEqual(['user-facing-rules', 'ask-rule']);
    expect(sections.every((s) => s.cacheable)).toBe(true);
    expect(sections[1].text).toContain('Costly to get wrong and not findable');
  });

  it('adds the unattended note, which opens the result with what was not done, only for unattended runs', () => {
    const sections = buildConversationRuleSections({ unattended: true });
    expect(sections.at(-1)?.name).toBe('unattended-run');
    expect(sections.at(-1)?.text).toContain('what was not done and why');
  });
});

describe('asking for a free value', () => {
  const rule = ASK_BEFORE_GUESSING;

  it('sends a question with no reasonable options (an unknown date) to a plain message, not to a tool call that would be refused', () => {
    expect(rule).toContain('an unknown date');
    expect(rule).toMatch(/ask for the value in a plain message and end your turn/);
    expect(rule).not.toContain('rely on the "Other" answer');
  });
});

describe('one ask rule', () => {
  it('no other prompt text tells the model to prefer asking or to wait for an ok', () => {
    const capability = getCapabilityPrompt();
    expect(DEFAULT_PLANNING).not.toContain('ask_user_question');
    expect(gptVariant.planning).not.toContain('ask_user_question');
    expect(capability).not.toContain('wait for "ok');
    expect(capability).not.toContain('Only reach out when you hit a problem');
    expect(capability).toContain('"When to ask the user"');
  });

  it('the default soul no longer carries the jargon rules (they are always-on) or offers a retry question', () => {
    const soul = getDefaultSoul();
    expect(soul).not.toContain('No technical jargon');
    expect(soul).not.toContain('Want me to try again');
  });
});
