import type { ReactNode } from 'react';
import { Server } from 'lucide-react';
import { Button } from '@/components/ui/button';

/** Shared presentation for available and configured connectors. */
export default function ConnectorRow({ name, description, provenance, trailing, onOpen }: {
  name: string;
  description?: string;
  provenance?: string;
  trailing?: ReactNode;
  onOpen?: () => void;
}) {
  const content = <>
    <Server className="h-4 w-4 shrink-0 text-[var(--abu-text-muted)]" />
    <span className="min-w-0 flex-1 text-left">
      <span title={name} className="block truncate text-h-xs text-[var(--abu-text-primary)]">{name}</span>
      <span className="block truncate text-minor text-[var(--abu-text-tertiary)]">{description}</span>
      {provenance && <span className="block truncate text-caption text-[var(--abu-text-muted)]">{provenance}</span>}
    </span>
  </>;
  return (
    <li data-testid="connector-row" className="flex items-center gap-3 rounded-lg border border-[var(--abu-border)] px-3 py-2.5">
      {onOpen ? (
        <Button variant="ghost" aria-label={name} onClick={onOpen} className="h-auto min-w-0 flex-1 justify-start gap-3 p-0 has-[>svg]:px-0 hover:bg-transparent">
          {content}
        </Button>
      ) : <div className="flex min-w-0 flex-1 items-center gap-3">{content}</div>}
      {trailing}
    </li>
  );
}
