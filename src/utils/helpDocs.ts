import type { SupportedLocale } from '@/i18n';

const HELP_DOCS_URLS = {
  'zh-CN': 'https://myabu.cn/docs.zh-CN.html#user-guide',
  'en-US': 'https://myabu.cn/docs.html#user-guide',
} as const satisfies Record<SupportedLocale, string>;

export function getHelpDocsUrl(locale: SupportedLocale): string {
  return HELP_DOCS_URLS[locale];
}
