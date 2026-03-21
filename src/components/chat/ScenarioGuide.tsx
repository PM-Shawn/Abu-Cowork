import { useState, useCallback } from 'react';
import { useI18n } from '@/i18n';
import { SCENARIO_CATEGORIES, DEFAULT_PROMPT_KEYS } from '@/data/scenarioPrompts';
import { cn } from '@/lib/utils';
import { FolderOpen, BarChart3, PenLine, Globe, Clock } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

const ICON_MAP: Record<string, LucideIcon> = {
  FolderOpen,
  BarChart3,
  PenLine,
  Globe,
  Clock,
};

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
    <div className="scenario-guide w-full mt-4">
      {/* Scenario Tags */}
      <div className="flex items-center gap-2 flex-wrap justify-center mb-4">
        {SCENARIO_CATEGORIES.map((cat) => {
          const Icon = ICON_MAP[cat.iconName];
          const isActive = activeScenario === cat.id;
          return (
            <button
              key={cat.id}
              onClick={() => handleScenarioClick(cat.id)}
              className={cn(
                'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[13px] font-medium transition-all',
                'border cursor-pointer select-none',
                isActive
                  ? 'bg-[var(--abu-text-primary)] text-[var(--abu-bg-base)] border-[var(--abu-text-primary)]'
                  : 'bg-[var(--abu-bg-muted)] text-[var(--abu-text-tertiary)] border-[var(--abu-border-subtle)] hover:border-[var(--abu-border-hover)] hover:text-[var(--abu-text-primary)]'
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              <span>{scenarios[cat.labelKey] ?? cat.labelKey}</span>
            </button>
          );
        })}
      </div>

      {/* Divider */}
      <div className="flex items-center gap-3 mb-3 px-1">
        <div className="flex-1 h-px bg-[var(--abu-border-subtle)]" />
        <span className="text-[12px] text-[var(--abu-text-muted)] shrink-0">{t.chat.trySaying}</span>
        <div className="flex-1 h-px bg-[var(--abu-border-subtle)]" />
      </div>

      {/* Example Prompts Grid */}
      <div className="grid grid-cols-2 gap-2 scenario-prompts-grid">
        {currentPromptKeys.map((key) => {
          const text = prompts[key];
          if (!text) return null;
          return (
            <button
              key={key}
              onClick={() => handlePromptClick(key)}
              className={cn(
                'text-left px-3.5 py-2.5 rounded-xl text-[13px] leading-relaxed transition-all cursor-pointer',
                'border border-[var(--abu-border-subtle)] bg-white/60 text-[var(--abu-text-secondary)]',
                'hover:bg-white hover:border-[var(--abu-border-hover)]',
                'active:scale-[0.98]',
                'scenario-prompt-item'
              )}
            >
              "{text}"
            </button>
          );
        })}
      </div>
    </div>
  );
}
