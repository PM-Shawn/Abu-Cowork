import { Bot, AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import type { InboxItem } from '@/types/todo';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';

interface InboxItemRowProps {
  item: InboxItem;
  onAccept: () => void;
  onIgnore: () => void;
  onView?: () => void;
}

function iconFor(type: InboxItem['type']) {
  switch (type) {
    case 'agent_proposed_todo':
      return <Bot className="h-4 w-4 text-[var(--abu-clay)]" />;
    case 'agent_confirmation':
      return <AlertTriangle className="h-4 w-4 text-amber-500" />;
    case 'agent_result':
      return <CheckCircle2 className="h-4 w-4 text-green-600" />;
    case 'agent_error':
      return <XCircle className="h-4 w-4 text-red-500" />;
  }
}

function labelFor(type: InboxItem['type'], t: ReturnType<typeof useI18n>['t']) {
  switch (type) {
    case 'agent_proposed_todo':
      return t.inbox.agentProposed;
    case 'agent_confirmation':
      return t.inbox.agentConfirmation;
    case 'agent_result':
      return t.inbox.agentResult;
    case 'agent_error':
      return t.inbox.agentError;
  }
}

export default function InboxItemRow({
  item,
  onAccept,
  onIgnore,
  onView,
}: InboxItemRowProps) {
  const { t } = useI18n();

  return (
    <div className="px-4 py-3 rounded-lg border border-[var(--abu-border)] bg-[var(--abu-bg-card)] hover:border-[var(--abu-clay-40)]">
      <div className="flex items-center gap-2 mb-2">
        {iconFor(item.type)}
        <span className="text-[12px] font-medium text-[var(--abu-text-secondary)]">
          {labelFor(item.type, t)}
        </span>
        {item.unread && <span className="ml-auto w-1.5 h-1.5 rounded-full bg-red-500" />}
      </div>
      <p className="text-[14px] text-[var(--abu-text-primary)] mb-3">
        {item.summary}
      </p>
      <div className="flex gap-2">
        {item.type === 'agent_proposed_todo' && (
          <>
            <Button size="sm" onClick={onAccept}>
              {t.inbox.accept}
            </Button>
            <Button size="sm" variant="ghost" onClick={onIgnore}>
              {t.inbox.ignore}
            </Button>
          </>
        )}
        {item.type === 'agent_result' && (
          <>
            {onView && (
              <Button size="sm" onClick={onView}>
                {t.inbox.viewResult}
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={onIgnore}>
              {t.inbox.close}
            </Button>
          </>
        )}
        {item.type === 'agent_confirmation' && (
          <>
            {onView && (
              <Button size="sm" onClick={onView}>
                {t.inbox.viewResult}
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={onIgnore}>
              {t.inbox.cancelTask}
            </Button>
          </>
        )}
        {item.type === 'agent_error' && (
          <>
            {onView && (
              <Button size="sm" onClick={onView}>
                {t.inbox.retry}
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={onIgnore}>
              {t.inbox.close}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
