import { useTriggerStore } from '@/stores/triggerStore';
import type { EditorTemplateDefaults } from '@/stores/triggerStore';
import { useI18n } from '@/i18n';
import { navigateToChatWithInput } from '@/utils/navigation';
import { Plus, Zap, Info, Wand2, AlertTriangle, FileText, Timer } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import TriggerCard from './TriggerCard';
import TriggerDetail from './TriggerDetail';
import TriggerEditor from './TriggerEditor';
import type { TranslationDict } from '@/i18n/types';

interface TriggerTemplate {
  icon: React.ReactNode;
  nameKey: keyof TranslationDict['trigger'];
  descKey: keyof TranslationDict['trigger'];
  promptKey: keyof TranslationDict['trigger'];
  keywordsKey?: keyof TranslationDict['trigger'];
  sourceType: 'http' | 'file' | 'cron';
  filterType: 'always' | 'keyword' | 'regex';
}

const TEMPLATES: TriggerTemplate[] = [
  {
    icon: <AlertTriangle className="h-4 w-4 text-amber-500" />,
    nameKey: 'templateAlertSOP',
    descKey: 'templateAlertSOPDesc',
    promptKey: 'templateAlertSOPPrompt',
    keywordsKey: 'templateAlertSOPKeywords',
    sourceType: 'http',
    filterType: 'keyword',
  },
  {
    icon: <FileText className="h-4 w-4 text-blue-500" />,
    nameKey: 'templateLogWatch',
    descKey: 'templateLogWatchDesc',
    promptKey: 'templateLogWatchPrompt',
    sourceType: 'file',
    filterType: 'always',
  },
  {
    icon: <Timer className="h-4 w-4 text-green-500" />,
    nameKey: 'templatePeriodicCheck',
    descKey: 'templatePeriodicCheckDesc',
    promptKey: 'templatePeriodicCheckPrompt',
    sourceType: 'cron',
    filterType: 'always',
  },
];

export default function TriggerView() {
  const { t } = useI18n();
  const { triggers, selectedTriggerId, openEditor } = useTriggerStore();

  const handleAskAbu = () => {
    navigateToChatWithInput(t.trigger.askAbuCreatePrompt);
  };

  const handleUseTemplate = (template: TriggerTemplate) => {
    const defaults: EditorTemplateDefaults = {
      name: t.trigger[template.nameKey] as string,
      sourceType: template.sourceType,
      filterType: template.filterType,
      prompt: t.trigger[template.promptKey] as string,
      keywords: template.keywordsKey ? (t.trigger[template.keywordsKey] as string) : undefined,
    };
    openEditor(undefined, defaults);
  };

  const sortedTriggers = Object.values(triggers).sort((a, b) => b.createdAt - a.createdAt);

  // Show detail page if a trigger is selected
  if (selectedTriggerId && triggers[selectedTriggerId]) {
    return (
      <div className="flex flex-col h-full bg-[var(--abu-bg-base)]">
        <TriggerDetail />
        <TriggerEditor />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-[var(--abu-bg-base)]">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--abu-border)]">
        <h1 className="text-[16px] font-semibold text-[var(--abu-text-primary)]">{t.trigger.title}</h1>
        {sortedTriggers.length > 0 && (
          <div className="flex items-center gap-2">
            <button
              onClick={handleAskAbu}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-medium bg-[var(--abu-bg-active)] text-[var(--abu-text-primary)] hover:bg-[var(--abu-border)] transition-colors shrink-0"
            >
              <Wand2 className="h-3.5 w-3.5 text-[var(--abu-clay)]" />
              {t.trigger.askAbuToCreate}
            </button>
            <button
              onClick={() => openEditor()}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-medium bg-[var(--abu-clay)] text-white hover:bg-[var(--abu-clay-hover)] transition-colors shrink-0"
            >
              <Plus className="h-3.5 w-3.5" />
              {t.trigger.newTrigger}
            </button>
          </div>
        )}
      </div>

      {/* Info banner */}
      <div className="mx-6 mt-4 flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--abu-bg-active)]/80 border border-[var(--abu-border-subtle)]">
        <Info className="h-3.5 w-3.5 text-[var(--abu-text-tertiary)] shrink-0" />
        <span className="text-[12px] text-[var(--abu-text-tertiary)]">{t.trigger.infoBanner}</span>
      </div>

      {/* Trigger list or empty state */}
      {sortedTriggers.length === 0 ? (
        <div className="flex-1 overflow-auto">
          <div className="flex flex-col items-center text-center px-6 pt-10">
            <div className="w-16 h-16 rounded-full bg-[var(--abu-bg-active)] flex items-center justify-center mb-4">
              <Zap className="h-7 w-7 text-[var(--abu-text-muted)]" />
            </div>
            <p className="text-[15px] text-[var(--abu-text-primary)] font-medium mb-1.5">
              {t.trigger.noTriggers}
            </p>
            <p className="text-[13px] text-[var(--abu-text-tertiary)] mb-5">
              {t.trigger.noTriggersHint}
            </p>
            <div className="flex items-center gap-3 mb-8">
              <button
                onClick={() => openEditor()}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13px] font-medium bg-[var(--abu-clay)] text-white hover:bg-[var(--abu-clay-hover)] transition-colors"
              >
                <Plus className="h-4 w-4" />
                {t.trigger.noTriggersCTA}
              </button>
              <button
                onClick={handleAskAbu}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13px] font-medium bg-[var(--abu-bg-active)] text-[var(--abu-text-primary)] hover:bg-[var(--abu-border)] transition-colors"
              >
                <Wand2 className="h-4 w-4 text-[var(--abu-clay)]" />
                {t.trigger.askAbuToCreate}
              </button>
            </div>

            {/* Template cards */}
            <div className="w-full max-w-md space-y-2">
              <p className="text-[12px] font-medium text-[var(--abu-text-tertiary)] text-left">{t.trigger.useTemplate}</p>
              {TEMPLATES.map((tpl) => (
                <button
                  key={tpl.nameKey}
                  onClick={() => handleUseTemplate(tpl)}
                  className="w-full flex items-center gap-3 px-4 py-3 rounded-xl bg-[var(--abu-bg-muted)] border border-[var(--abu-border)] hover:border-[var(--abu-border-hover)] transition-all text-left"
                >
                  <div className="w-8 h-8 rounded-lg bg-[var(--abu-bg-muted)] flex items-center justify-center shrink-0">
                    {tpl.icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] font-medium text-[var(--abu-text-primary)]">{t.trigger[tpl.nameKey]}</p>
                    <p className="text-[11px] text-[var(--abu-text-tertiary)] truncate">{t.trigger[tpl.descKey]}</p>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <ScrollArea className="flex-1">
          <div className="px-6 py-4 space-y-3">
            {sortedTriggers.map((trigger) => (
              <TriggerCard key={trigger.id} trigger={trigger} />
            ))}
          </div>
        </ScrollArea>
      )}

      {/* Editor modal */}
      <TriggerEditor />
    </div>
  );
}
