import { memo } from 'react';
import { Button } from '@/components/ds/button';
import { AppIcons } from '@/components/ds/icons';
import ScheduleView from '@/components/schedule/ScheduleView';
import TopTabNav, { type TopTabNavItem } from '@/components/toolbox/TopTabNav';
import TriggerView from '@/components/trigger/TriggerView';
import { useI18n } from '@/i18n';
import { useScheduleStore } from '@/stores/scheduleStore';
import { useSettingsStore, type AutomationTab } from '@/stores/settingsStore';
import { useTriggerStore } from '@/stores/triggerStore';
import { navigateToChatWithInput } from '@/utils/navigation';

/**
 * The automation page: its two tabs and the create buttons of the tab in view. `App` renders
 * for every piece of a streamed reply, so the page takes no props and reads one field at a time.
 */
const AutomationView = memo(function AutomationView() {
  const activeAutomationTab = useSettingsStore((s) => s.activeAutomationTab);
  const setActiveAutomationTab = useSettingsStore((s) => s.setActiveAutomationTab);
  const { t } = useI18n();

  const navItems: TopTabNavItem<AutomationTab>[] = [
    { id: 'schedule', label: t.sidebar.scheduledTasks, icon: AppIcons.clock },
    { id: 'trigger', label: t.sidebar.triggers, icon: AppIcons.trigger },
  ];

  // The create buttons sit in the page header, whether or not the list has items. Creating by
  // hand is the page's one filled button; a page that has no card left gives the focus to it.
  const actions = activeAutomationTab === 'schedule' ? (
    <>
      <Button variant="secondary" icon={AppIcons.askAbu} onClick={() => navigateToChatWithInput(t.schedule.askAbuCreatePrompt)}>
        {t.schedule.askAbuToCreate}
      </Button>
      <Button variant="primary" icon={AppIcons.add} data-testid="automation-create" onClick={() => useScheduleStore.getState().openEditor()}>
        {t.schedule.newTask}
      </Button>
    </>
  ) : (
    <>
      <Button variant="secondary" icon={AppIcons.askAbu} onClick={() => navigateToChatWithInput(t.trigger.askAbuCreatePrompt)}>
        {t.trigger.askAbuToCreate}
      </Button>
      <Button variant="primary" icon={AppIcons.add} data-testid="automation-create" onClick={() => useTriggerStore.getState().openEditor()}>
        {t.trigger.newTrigger}
      </Button>
    </>
  );

  return (
    <div className="flex h-full flex-col">
      {/* Tabs on the left, create buttons on the right, below the window's own controls and
          in the same centered column as the content. */}
      <TopTabNav
        items={navItems}
        activeId={activeAutomationTab}
        onSelect={setActiveAutomationTab}
        belowChrome
        right={actions}
      />

      <div className="flex-1 overflow-hidden">
        {activeAutomationTab === 'schedule' && <ScheduleView />}
        {activeAutomationTab === 'trigger' && <TriggerView />}
      </div>
    </div>
  );
});

export default AutomationView;
