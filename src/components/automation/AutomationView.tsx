import { useSettingsStore, type AutomationTab } from '@/stores/settingsStore';
import { useI18n } from '@/i18n';
import { Clock, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import ScheduleView from '@/components/schedule/ScheduleView';
import TriggerView from '@/components/trigger/TriggerView';

export default function AutomationView() {
  const { activeAutomationTab, setActiveAutomationTab } = useSettingsStore();
  const { t } = useI18n();

  const navItems: { id: AutomationTab; label: string; icon: typeof Clock }[] = [
    { id: 'schedule', label: t.sidebar.scheduledTasks, icon: Clock },
    { id: 'trigger', label: t.sidebar.triggers, icon: Zap },
  ];

  return (
    <div className="h-full bg-[var(--abu-bg-base)] flex">
      {/* Left Navigation — sub-nav for automation types */}
      <nav className="w-[200px] shrink-0 border-r border-[var(--abu-border)] flex flex-col pt-4">
        <div className="px-3 space-y-0.5">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeAutomationTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setActiveAutomationTab(item.id)}
                className={cn(
                  'w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-colors text-left',
                  isActive
                    ? 'bg-[var(--abu-bg-active)] text-[var(--abu-text-primary)]'
                    : 'text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)]'
                )}
              >
                <Icon className={cn(
                  'h-[18px] w-[18px] shrink-0',
                  isActive ? 'text-[var(--abu-clay)]' : 'text-[var(--abu-text-muted)]'
                )} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
      </nav>

      {/* Right Content */}
      <div className="flex-1 overflow-hidden">
        {activeAutomationTab === 'schedule' && <ScheduleView />}
        {activeAutomationTab === 'trigger' && <TriggerView />}
      </div>
    </div>
  );
}
