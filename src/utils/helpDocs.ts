import type { SupportedLocale } from '@/i18n';

/** Official download site — where "this build cannot auto-update" surfaces
 *  (About caption, account menu, diagnostics) send the user for the latest
 *  installer. */
export const OFFICIAL_WEBSITE_URL = 'https://myabu.cn';

const HELP_DOCS_URLS = {
  'zh-CN': 'https://myabu.cn/docs.zh-CN.html#user-guide',
  'en-US': 'https://myabu.cn/docs.html#user-guide',
} as const satisfies Record<SupportedLocale, string>;

export function getHelpDocsUrl(locale: SupportedLocale): string {
  return HELP_DOCS_URLS[locale];
}
