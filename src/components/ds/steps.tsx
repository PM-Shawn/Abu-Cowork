import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { StatusIcon } from './status-icon';

export type StepStatus = 'done' | 'current' | 'pending' | 'error';

export interface Step {
  title: ReactNode;
  description?: ReactNode;
  status: StepStatus;
  // Read aloud for done and error steps, e.g. "Done", "Failed".
  statusLabel?: string;
}

function Marker({ status, statusLabel }: { status: StepStatus; statusLabel?: string }) {
  if (status === 'done') return <StatusIcon tone="success" size="sm" label={statusLabel} />;
  if (status === 'error') return <StatusIcon tone="danger" size="sm" label={statusLabel} />;
  return <span className={cn('h-2 w-2 rounded-full', status === 'current' ? 'bg-emphasis' : 'border border-control-border')} />;
}

export function Steps({ steps, label }: { steps: Step[]; label: string }) {
  return (
    <ol aria-label={label} className="flex flex-col gap-3">
      {steps.map((step, index) => (
        <li key={index} aria-current={step.status === 'current' ? 'step' : undefined} className="flex gap-2">
          <span className="flex h-5 w-4 shrink-0 items-center justify-center">
            <Marker status={step.status} statusLabel={step.statusLabel} />
          </span>
          <div className="min-w-0">
            <div className={cn('text-ui', step.status === 'pending' ? 'text-label-secondary' : 'text-label')}>{step.title}</div>
            {step.description && <div className="mt-1 text-ui-sm text-label-secondary">{step.description}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}
