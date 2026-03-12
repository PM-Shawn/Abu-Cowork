/**
 * Scenario categories and example prompts for the new conversation guide.
 * Each scenario has a set of clickable example prompts to help users get started.
 */

export interface ScenarioCategory {
  id: string;
  labelKey: string;      // i18n key under chat.scenarios
  /** Lucide icon name — resolved in ScenarioGuide component */
  iconName: 'FolderOpen' | 'BarChart3' | 'PenLine' | 'Globe' | 'Clock';
  placeholderKey: string; // i18n key for input placeholder
  prompts: string[];     // i18n keys under chat.scenarioPrompts
}

/**
 * Scenario definitions — the labels and prompts are i18n keys,
 * resolved at render time via the translation dict.
 */
export const SCENARIO_CATEGORIES: ScenarioCategory[] = [
  {
    id: 'office',
    labelKey: 'office',
    iconName: 'FolderOpen',
    placeholderKey: 'officePlaceholder',
    prompts: ['office1', 'office2', 'office3', 'office4'],
  },
  {
    id: 'data',
    labelKey: 'data',
    iconName: 'BarChart3',
    placeholderKey: 'dataPlaceholder',
    prompts: ['data1', 'data2', 'data3', 'data4'],
  },
  {
    id: 'content',
    labelKey: 'content',
    iconName: 'PenLine',
    placeholderKey: 'contentPlaceholder',
    prompts: ['content1', 'content2', 'content3', 'content4'],
  },
  {
    id: 'web',
    labelKey: 'web',
    iconName: 'Globe',
    placeholderKey: 'webPlaceholder',
    prompts: ['web1', 'web2', 'web3', 'web4'],
  },
  {
    id: 'schedule',
    labelKey: 'schedule',
    iconName: 'Clock',
    placeholderKey: 'schedulePlaceholder',
    prompts: ['schedule1', 'schedule2', 'schedule3', 'schedule4'],
  },
];

/** Default prompts shown when no scenario is selected */
export const DEFAULT_PROMPT_KEYS = ['default1', 'default2', 'default3', 'default4'];
