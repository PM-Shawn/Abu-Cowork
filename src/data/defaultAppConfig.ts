import type { AppConfig, AppMode, LocalizedText } from '@/types/app';
import { SCENARIO_CATEGORIES } from './scenarioPrompts';
import zhCN from '@/i18n/locales/zh-CN';
import enUS from '@/i18n/locales/en-US';

/**
 * The general shell described the way an app is: the six navigation entries
 * Abu shows when no app is selected, and the welcome scenarios as one mode.
 * `AppSwitcher` and the sidebar read this for `GENERAL_APP_ID`; the welcome
 * page itself keeps `ScenarioGuide`, whose data this is derived from, so the
 * two cannot disagree.
 */
function text(pick: (dict: typeof zhCN) => string): LocalizedText {
  return { 'zh-CN': pick(zhCN), 'en-US': pick(enUS) };
}

const generalMode: AppMode = {
  modeId: 'general',
  title: text((dict) => dict.chat.welcomeTitle),
  scenes: SCENARIO_CATEGORIES.map((category) => ({
    id: category.id,
    title: text((dict) => (dict.chat.scenarios as Record<string, string>)[category.labelKey]),
    placeholder: text((dict) => (dict.chat.scenarioPlaceholders as Record<string, string>)[category.placeholderKey]),
    templates: category.prompts.map((key) => ({
      id: key,
      title: text((dict) => (dict.chat.scenarioPrompts as Record<string, string>)[key]),
      prompt: text((dict) => {
        const full = dict.chat.scenarioFullPrompts as Record<string, string>;
        const short = dict.chat.scenarioPrompts as Record<string, string>;
        return full[key] ?? short[key];
      }),
    })),
  })),
};

export const DEFAULT_APP_CONFIG: AppConfig = {
  version: 1,
  home: { modes: { items: [generalMode] } },
  nav: {
    items: [
      { id: 'chat', target: 'builtin:chat', order: 1 },
      { id: 'todos', target: 'builtin:todos', order: 2 },
      { id: 'inbox', target: 'builtin:inbox', order: 3 },
      { id: 'team', target: 'builtin:team', order: 4 },
      { id: 'extensions', target: 'builtin:extensions', order: 5 },
      { id: 'automation', target: 'builtin:automation', order: 6 },
    ],
  },
};
