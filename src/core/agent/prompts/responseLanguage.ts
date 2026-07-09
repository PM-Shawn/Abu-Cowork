/**
 * Output-language control for the agent system prompt.
 *
 * Historically Abu's system prompt was written in Chinese, which *implicitly*
 * made the model reply in Chinese. As the prompt moves to English that implicit
 * anchor disappears, so we inject an explicit instruction that ties the reply
 * language to the resolved UI locale — while still letting the user's actual
 * message language override it.
 *
 * Pattern mirrors WorkBuddy's `<response_language>` block: a locale-driven
 * default plus a "follow the user's message" override plus a caveat that
 * technical content (code / paths / logs) must not flip the language.
 */

import type { SupportedLocale } from '../../../i18n/types';
import { getLocale } from '../../../i18n';

// Deliberately asymmetric, matching WorkBuddy's proven behavior:
//   - zh-CN: always Simplified Chinese, with NO "follow the message language"
//     override — Chinese users routinely paste English content (logs, code,
//     quotes) and still expect a Chinese answer, so an override would regress
//     them. This also preserves the historical always-Chinese behavior.
//   - en-US: English by default, but follow the user's message language when the
//     message itself is written in another language, ignoring technical content.
const RESPONSE_LANGUAGE_BY_LOCALE: Record<SupportedLocale, string> = {
  'zh-CN': '用户当前的界面语言是简体中文，请始终使用简体中文回复。',
  'en-US':
    "The user's interface language is English, so respond in English by default.\n" +
    'If the user\'s message itself is written in another language (e.g. Chinese), respond in that language instead.\n' +
    'IMPORTANT: Decide the reply language solely from the natural language of the user\'s message, not from technical content like code, paths, or logs.',
};

/**
 * Return the response-language instruction for a given locale (pure).
 */
export function resolveResponseLanguage(locale: SupportedLocale): string {
  return RESPONSE_LANGUAGE_BY_LOCALE[locale];
}

/**
 * Build the `## Response Language` system-prompt section for the current
 * resolved UI locale. Injected at the end of the system prompt.
 */
export function buildResponseLanguageSection(): string {
  return '\n## Response Language\n' + resolveResponseLanguage(getLocale());
}
