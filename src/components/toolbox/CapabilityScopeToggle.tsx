import { Building2, UserRound } from 'lucide-react';
import { cn } from '@/lib/utils';

export type CapabilityScope = 'personal' | 'organization';

interface CapabilityScopeToggleProps {
  value: CapabilityScope;
  onChange: (value: CapabilityScope) => void;
  personalLabel: string;
  organizationLabel: string;
}

/**
 * Switches the Skill/MCP catalog between user-owned and organization-managed
 * capabilities. This is deliberately a source selector, not a separate
 * capability type: Skills and MCP keep their own runtime semantics.
 */
export default function CapabilityScopeToggle({
  value,
  onChange,
  personalLabel,
  organizationLabel,
}: CapabilityScopeToggleProps) {
  const items = [
    { id: 'personal' as const, label: personalLabel, icon: UserRound },
    { id: 'organization' as const, label: organizationLabel, icon: Building2 },
  ];

  return (
    <div
      role="group"
      aria-label={`${personalLabel} / ${organizationLabel}`}
      className="flex items-center gap-0.5 rounded-lg bg-[var(--abu-bg-hover)] p-0.5"
    >
      {items.map((item) => {
        const Icon = item.icon;
        const active = value === item.id;
        return (
          <button
            key={item.id}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(item.id)}
            className={cn(
              'flex h-7 items-center gap-1.5 rounded-md px-2.5 text-minor font-medium transition-colors',
              active
                ? 'bg-[var(--abu-bg-base)] text-[var(--abu-text-primary)] shadow-sm'
                : 'text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)]',
            )}
          >
            <Icon className={cn('h-3.5 w-3.5', active && 'text-[var(--abu-clay)]')} />
            <span>{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}
