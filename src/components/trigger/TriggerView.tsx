import { useId, type ComponentProps } from 'react';
import { useListDetailFocus } from '@/components/automation/useListDetailFocus';
import { EmptyState } from '@/components/ds/empty-state';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { InlineMessage } from '@/components/ds/inline-message';
import { Pressable } from '@/components/ds/pressable';
import { ScrollArea } from '@/components/ds/scroll-area';
import ToolGrid from '@/components/toolbox/ToolGrid';
import { useI18n } from '@/i18n';
import type { TranslationDict } from '@/i18n/types';
import { useTriggerStore } from '@/stores/triggerStore';
import type { EditorTemplateDefaults } from '@/stores/triggerStore';
import type { Trigger } from '@/types/trigger';
import TriggerCard from './TriggerCard';
import TriggerDetail from './TriggerDetail';
import TriggerEditor from './TriggerEditor';

interface TriggerTemplate {
  /** A design-system icon: `AppIcons.*`. */
  icon: ComponentProps<typeof Icon>['icon'];
  // The mark keeps a status color because each has its own shape.
  tone: string;
  nameKey: keyof TranslationDict['trigger'];
  descKey: keyof TranslationDict['trigger'];
  promptKey: keyof TranslationDict['trigger'];
  keywordsKey?: keyof TranslationDict['trigger'];
  sourceType: 'http' | 'file' | 'cron';
  filterType: 'always' | 'keyword' | 'regex';
}

const TEMPLATES: TriggerTemplate[] = [
  {
    icon: AppIcons.warning,
    tone: 'text-warning',
    nameKey: 'templateAlertSOP',
    descKey: 'templateAlertSOPDesc',
    promptKey: 'templateAlertSOPPrompt',
    keywordsKey: 'templateAlertSOPKeywords',
    sourceType: 'http',
    filterType: 'keyword',
  },
  {
    icon: AppIcons.file,
    tone: 'text-info',
    nameKey: 'templateLogWatch',
    descKey: 'templateLogWatchDesc',
    promptKey: 'templateLogWatchPrompt',
    sourceType: 'file',
    filterType: 'always',
  },
  {
    icon: AppIcons.timer,
    tone: 'text-success',
    nameKey: 'templatePeriodicCheck',
    descKey: 'templatePeriodicCheckDesc',
    promptKey: 'templatePeriodicCheckPrompt',
    sourceType: 'cron',
    filterType: 'always',
  },
];

const newestFirst = (triggers: Record<string, Trigger>) => Object.values(triggers).sort((a, b) => b.createdAt - a.createdAt);
// Where a listener sits in the list as the store has it now.
const placeOf = (id: string) => newestFirst(useTriggerStore.getState().triggers).findIndex((trigger) => trigger.id === id);

/** One ready-made listener: the button is named after the template and described by what it does. */
function TemplateCard({ template, onUse }: { template: TriggerTemplate; onUse: (template: TriggerTemplate) => void }) {
  const { t } = useI18n();
  const id = useId();
  return (
    <Pressable
      aria-labelledby={`${id}-name`}
      aria-describedby={`${id}-desc`}
      onClick={() => onUse(template)}
      className="flex w-full items-center gap-3 rounded-panel border border-separator px-4 py-3 text-left hover:bg-fill-hover"
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-control bg-fill">
        <Icon icon={template.icon} size="md" className={template.tone} />
      </span>
      <span className="min-w-0 flex-1">
        <span id={`${id}-name`} className="block text-ui font-medium text-label">{t.trigger[template.nameKey]}</span>
        <span id={`${id}-desc`} className="block truncate text-caption text-label-tertiary">{t.trigger[template.descKey]}</span>
      </span>
    </Pressable>
  );
}

export default function TriggerView() {
  const { t } = useI18n();
  const triggers = useTriggerStore((s) => s.triggers);
  const selectedTriggerId = useTriggerStore((s) => s.selectedTriggerId);

  const sortedTriggers = newestFirst(triggers);
  // The listener whose page is in view; the list is in view when there is none.
  const detailId = selectedTriggerId && triggers[selectedTriggerId] ? selectedTriggerId : null;

  // The list and a listener's page replace each other under the keyboard; the focus follows them.
  const { root, afterLayer, editorCloseAutoFocus } = useListDetailFocus(detailId, placeOf);

  const handleUseTemplate = (template: TriggerTemplate) => {
    const defaults: EditorTemplateDefaults = {
      name: t.trigger[template.nameKey] as string,
      sourceType: template.sourceType,
      filterType: template.filterType,
      prompt: t.trigger[template.promptKey] as string,
      keywords: template.keywordsKey ? (t.trigger[template.keywordsKey] as string) : undefined,
    };
    useTriggerStore.getState().openEditor(undefined, defaults);
  };

  return (
    <div ref={root} className="flex h-full flex-col">
      {detailId ? <TriggerDetail onQuestionClosed={afterLayer} /> : (
        <>
          {/* What a listener is for, in the same centered column as the tabs above and the list below. */}
          <div className="px-8 pt-4 pb-2">
            <div className="mx-auto max-w-5xl">
              <InlineMessage tone="info">{t.trigger.infoBanner}</InlineMessage>
            </div>
          </div>

          {sortedTriggers.length === 0 ? (
            <ScrollArea className="min-h-0 flex-1">
              <div className="flex flex-col items-center px-6 pt-4 pb-8">
                <EmptyState icon={AppIcons.trigger} title={t.trigger.noTriggers} description={t.trigger.noTriggersHint} />
                {/* Ready-made listeners to start from. */}
                <div className="w-full max-w-md space-y-2">
                  <p className="text-ui-sm font-medium text-label-tertiary">{t.trigger.useTemplate}</p>
                  {TEMPLATES.map((template) => (
                    <TemplateCard key={template.nameKey} template={template} onUse={handleUseTemplate} />
                  ))}
                </div>
              </div>
            </ScrollArea>
          ) : (
            <ScrollArea className="min-h-0 flex-1">
              <div className="px-8 py-4">
                <div className="mx-auto max-w-5xl">
                  <ToolGrid>
                    {sortedTriggers.map((trigger) => (
                      <TriggerCard key={trigger.id} trigger={trigger} />
                    ))}
                  </ToolGrid>
                </div>
              </div>
            </ScrollArea>
          )}
        </>
      )}

      {/* One editor for the list and for a listener's page: it stays mounted while they replace each other. */}
      <TriggerEditor onCloseAutoFocus={editorCloseAutoFocus} />
    </div>
  );
}
