import { useTriggerStore } from '@/stores/triggerStore';
import type { EditorTemplateDefaults } from '@/stores/triggerStore';
import { useI18n } from '@/i18n';
import { Zap, Info, AlertTriangle, FileText, Timer } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import TriggerCard from './TriggerCard';
import TriggerDetail from './TriggerDetail';
import TriggerEditor from './TriggerEditor';
import ToolGrid from '@/components/toolbox/ToolGrid';
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
      {/* Run-condition hint — the create actions now live in AutomationView's
          shared content-area header. Inset with px-8 + max-w-5xl so it lines
          up with the list below (and with the header's tabs/actions above). */}
      <div className="px-8 pt-4 pb-2">
        <div className="max-w-5xl mx-auto flex items-center gap-1.5 text-[12px] text-[var(--abu-text-tertiary)] min-w-0">
          <Info className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{t.trigger.infoBanner}</span>
        </div>
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
            <p className="text-[13px] text-[var(--abu-text-tertiary)] mb-8">
              {t.trigger.noTriggersHint}
            </p>

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
          <div className="px-8 py-4">
            <div className="max-w-5xl mx-auto">
              <ToolGrid>
                {sortedTriggers.map((trigger) => (
                  <TriggerCard key={trigger.id} trigger={trigger} />
                ))}
              </ToolGrid>
            </div>
          </div>
        </ScrollArea>
      )}

      {/* Editor modal */}
      <TriggerEditor />
    </div>
  );
}
