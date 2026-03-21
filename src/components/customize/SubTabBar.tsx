import { cn } from '@/lib/utils';

interface SubTab {
  id: string;
  label: string;
  count?: number;
}

interface SubTabBarProps {
  tabs: SubTab[];
  activeTab: string;
  onChange: (id: string) => void;
}

export default function SubTabBar({ tabs, activeTab, onChange }: SubTabBarProps) {
  return (
    <div className="flex items-center gap-1 p-1 bg-[var(--abu-bg-active)] rounded-lg">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onChange(tab.id)}
          className={cn(
            'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors',
            activeTab === tab.id
              ? 'bg-white text-[var(--abu-text-primary)]'
              : 'text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)] hover:bg-white/50'
          )}
        >
          <span>{tab.label}</span>
          {tab.count !== undefined && (
            <span className={cn(
              'text-[10px] min-w-[18px] text-center px-1 py-0.5 rounded-full',
              activeTab === tab.id
                ? 'bg-[var(--abu-clay-bg)] text-[var(--abu-clay)]'
                : 'bg-neutral-200/60 text-[var(--abu-text-muted)]'
            )}>
              {tab.count}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
