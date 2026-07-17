import { useSettingsStore, type AutomationTab } from '@/stores/settingsStore';
import { useScheduleStore } from '@/stores/scheduleStore';
import { useTriggerStore } from '@/stores/triggerStore';
import { useI18n } from '@/i18n';
import { navigateToChatWithInput } from '@/utils/navigation';
import { Clock, Zap, Plus, Wand2 } from 'lucide-react';
import ScheduleView from '@/components/schedule/ScheduleView';
import TriggerView from '@/components/trigger/TriggerView';
import TopTabNav from '@/components/toolbox/TopTabNav';

export default function AutomationView() {
  const { activeAutomationTab, setActiveAutomationTab } = useSettingsStore();
  const { t } = useI18n();

  const navItems: { id: AutomationTab; label: string; icon: typeof Clock }[] = [
    { id: 'schedule', label: t.sidebar.scheduledTasks, icon: Clock },
    { id: 'trigger', label: t.sidebar.triggers, icon: Zap },
  ];

  // Header-right create actions — lifted here from ScheduleView/TriggerView so
  // they live in the shared content-area header (matches ToolboxModal). Always
  // shown, regardless of item count (unlike the old per-view action row that
  // only appeared once the list was non-empty).
  const renderActions = () => {
    if (activeAutomationTab === 'schedule') {
      return (
        <>
          <button
            onClick={() => navigateToChatWithInput(t.schedule.askAbuCreatePrompt)}
            className="flex items-center gap-1.5 h-8 px-3 rounded-lg text-[13px] font-medium bg-[var(--abu-bg-active)] text-[var(--abu-text-primary)] hover:bg-[var(--abu-border)] transition-colors shrink-0"
          >
            <Wand2 className="h-3.5 w-3.5 text-[var(--abu-clay)]" />
            {t.schedule.askAbuToCreate}
          </button>
          <button
            onClick={() => useScheduleStore.getState().openEditor()}
            className="flex items-center gap-1.5 h-8 px-3 rounded-lg text-[13px] font-medium bg-[var(--abu-clay)] text-white hover:bg-[var(--abu-clay-hover)] transition-colors shrink-0"
          >
            <Plus className="h-3.5 w-3.5" />
            {t.schedule.newTask}
          </button>
        </>
      );
    }
    return (
      <>
        <button
          onClick={() => navigateToChatWithInput(t.trigger.askAbuCreatePrompt)}
          className="flex items-center gap-1.5 h-8 px-3 rounded-lg text-[13px] font-medium bg-[var(--abu-bg-active)] text-[var(--abu-text-primary)] hover:bg-[var(--abu-border)] transition-colors shrink-0"
        >
          <Wand2 className="h-3.5 w-3.5 text-[var(--abu-clay)]" />
          {t.trigger.askAbuToCreate}
        </button>
        <button
          onClick={() => useTriggerStore.getState().openEditor()}
          className="flex items-center gap-1.5 h-8 px-3 rounded-lg text-[13px] font-medium bg-[var(--abu-clay)] text-white hover:bg-[var(--abu-clay-hover)] transition-colors shrink-0"
        >
          <Plus className="h-3.5 w-3.5" />
          {t.trigger.newTrigger}
        </button>
      </>
    );
  };

  return (
    <div className="h-full bg-[var(--abu-bg-base)] flex flex-col">
      {/* Content-area header row — tabs left, create actions right. Sits below
          the window's floating title-bar controls, matching ToolboxModal's
          `belowChrome` header (centered in a max-w-5xl container so it lines
          up with the content below). */}
      <TopTabNav
        items={navItems}
        activeId={activeAutomationTab}
        onSelect={setActiveAutomationTab}
        belowChrome
        right={renderActions()}
      />

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {activeAutomationTab === 'schedule' && <ScheduleView />}
        {activeAutomationTab === 'trigger' && <TriggerView />}
      </div>
    </div>
  );
}
