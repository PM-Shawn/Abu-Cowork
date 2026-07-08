import { describe, it, expect } from 'vitest';
import { resolveResponseLanguage } from './responseLanguage';

/**
 * Output-language control (P0 of the prompt English-ization work).
 *
 * The agent system prompt is (historically) Chinese, which implicitly made the
 * model reply in Chinese. Once prompts move to English that implicit anchor is
 * gone, so we inject an explicit "respond in {locale}" instruction driven by the
 * resolved UI locale. Pattern mirrors WorkBuddy's `<response_language>` block,
 * including its deliberate asymmetry:
 *   - zh-CN locale → always Simplified Chinese (no message-language override),
 *     so a Chinese user pasting English content is NOT flipped to English.
 *   - en-US locale → English by default, but follow the user's message language
 *     when the message itself is written in another language.
 */
describe('resolveResponseLanguage', () => {
  it('always instructs Simplified Chinese for the zh-CN locale', () => {
    const zh = resolveResponseLanguage('zh-CN');
    expect(zh).toContain('简体中文');
    // Must NOT leak a "follow the message language" override — that would let an
    // English paste flip a Chinese user's whole reply to English (a regression).
    expect(zh).not.toMatch(/其他语言|another language/);
  });

  it('instructs English by default for the en-US locale', () => {
    expect(resolveResponseLanguage('en-US')).toContain('English');
  });

  it('lets the user message language override the default for en-US', () => {
    // en-US user who writes Chinese should get Chinese back.
    const en = resolveResponseLanguage('en-US');
    expect(en).toMatch(/message/i);
    expect(en).toMatch(/Chinese/);
  });

  it('warns en-US against basing the decision on code / paths / logs', () => {
    // WorkBuddy-proven caveat: technical content must not flip the output language.
    expect(resolveResponseLanguage('en-US')).toMatch(/code|paths?|logs?/i);
  });

  it('produces distinct instructions per locale', () => {
    expect(resolveResponseLanguage('zh-CN')).not.toBe(resolveResponseLanguage('en-US'));
  });
});
