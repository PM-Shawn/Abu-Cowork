import { useState, useCallback } from 'react';
import { useI18n } from '@/i18n';
import { SCENARIO_CATEGORIES, DEFAULT_PROMPT_KEYS, type ScenarioCategory } from '@/data/scenarioPrompts';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { Pressable } from '@/components/ds/pressable';
import { PROMPT_GRID_CLASS, PROMPT_ITEM_CLASS } from './promptGrid';

const ICON_MAP = {
  FolderOpen: AppIcons.folderOpen,
  BarChart3: AppIcons.chart,
  PenLine: AppIcons.write,
  Globe: AppIcons.webPage,
  Clock: AppIcons.clock,
} as const satisfies Record<ScenarioCategory['iconName'], unknown>;

interface ScenarioGuideProps {
  onSelectPrompt: (prompt: string) => void;
  onScenarioChange?: (placeholderKey: string | null) => void;
  visible: boolean;
}

export default function ScenarioGuide({ onSelectPrompt, onScenarioChange, visible }: ScenarioGuideProps) {
  const { t } = useI18n();
  const [activeScenario, setActiveScenario] = useState<string | null>(null);

  const scenarios = t.chat.scenarios as Record<string, string>;
  const prompts = t.chat.scenarioPrompts as Record<string, string>;
  const fullPrompts = t.chat.scenarioFullPrompts as Record<string, string>;
  const placeholders = t.chat.scenarioPlaceholders as Record<string, string>;

  const handleScenarioClick = useCallback((scenarioId: string) => {
    const next = activeScenario === scenarioId ? null : scenarioId;
    setActiveScenario(next);

    if (next) {
      const cat = SCENARIO_CATEGORIES.find((c) => c.id === next);
      onScenarioChange?.(cat ? placeholders[cat.placeholderKey] ?? null : null);
    } else {
      onScenarioChange?.(null);
    }
  }, [activeScenario, onScenarioChange, placeholders]);

  const handlePromptClick = useCallback((key: string) => {
    // Use full prompt if available, otherwise fall back to the title
    const text = fullPrompts[key] ?? prompts[key];
    if (text) onSelectPrompt(text);
  }, [prompts, fullPrompts, onSelectPrompt]);

  // Determine which prompt keys to show
  const activeCat = SCENARIO_CATEGORIES.find((c) => c.id === activeScenario);
  const currentPromptKeys = activeCat ? activeCat.prompts : DEFAULT_PROMPT_KEYS;

  if (!visible) return null;

  return (
    <div className="mt-4 w-full">
      {/* Scenario Tags */}
      <div className="mb-4 flex flex-wrap items-center justify-center gap-2">
        {SCENARIO_CATEGORIES.map((cat) => {
          const isActive = activeScenario === cat.id;
          return (
            <Pressable
              key={cat.id}
              aria-pressed={isActive}
              onClick={() => handleScenarioClick(cat.id)}
              className={cn(
                'inline-flex h-7 select-none items-center gap-1 rounded-control px-3 text-ui font-medium',
                isActive ? 'bg-fill-selected text-label' : 'bg-fill text-label-secondary hover:bg-fill-hover hover:text-label',
              )}
            >
              <Icon icon={ICON_MAP[cat.iconName]} size="sm" />
              <span>{scenarios[cat.labelKey] ?? cat.labelKey}</span>
            </Pressable>
          );
        })}
      </div>

      {/* Divider */}
      <div className="mb-3 flex items-center gap-3 px-1">
        <div className="h-px flex-1 bg-separator" />
        <span className="shrink-0 text-ui-sm text-label-tertiary">{t.chat.trySaying}</span>
        <div className="h-px flex-1 bg-separator" />
      </div>

      {/* Example Prompts Grid */}
      <div className={PROMPT_GRID_CLASS}>
        {currentPromptKeys.map((key) => {
          const text = prompts[key];
          if (!text) return null;
          return (
            <Pressable
              key={key}
              onClick={() => handlePromptClick(key)}
              className={PROMPT_ITEM_CLASS}
            >
              "{text}"
            </Pressable>
          );
        })}
      </div>
    </div>
  );
}
