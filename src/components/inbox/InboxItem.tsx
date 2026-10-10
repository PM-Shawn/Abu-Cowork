import type { InboxItem } from '@/types/todo';
import { Button } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { StatusIcon } from '@/components/ds/status-icon';
import { Tag } from '@/components/ds/tag';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

interface InboxItemRowProps {
  item: InboxItem;
  onAccept: () => void;
  onIgnore: () => void;
  onView?: () => void;
}

function iconFor(type: InboxItem['type']) {
  switch (type) {
    case 'agent_proposed_todo':
      return <Icon icon={AppIcons.agent} size="md" className="text-label-secondary" />;
    case 'agent_confirmation':
      return <Icon icon={AppIcons.warning} size="md" className="text-warning" />;
    case 'agent_result':
      return <Icon icon={AppIcons.success} size="md" className="text-success" />;
    case 'agent_error':
      return <Icon icon={AppIcons.error} size="md" className="text-danger" />;
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
  const processed = item.status !== 'pending';

  return (
    <div
      data-inbox-item={item.id}
      className={cn('rounded-panel border border-separator bg-surface px-4 py-3', processed && 'opacity-60')}
    >
      <div className="mb-2 flex items-center gap-2">
        {iconFor(item.type)}
        <span className="text-ui-sm font-medium text-label-secondary">
          {labelFor(item.type, t)}
        </span>
        {item.unread && !processed && (
          <StatusIcon tone="info" size="sm" label={t.inboxTabs.pending} />
        )}
        {item.status === 'accepted' && (
          <span className="ml-auto"><Tag tone="success">{t.inboxTabs.statusAccepted}</Tag></span>
        )}
        {item.status === 'ignored' && (
          <span className="ml-auto"><Tag>{t.inboxTabs.statusIgnored}</Tag></span>
        )}
      </div>
      <p className="mb-3 whitespace-pre-wrap text-ui text-label">
        {item.summary}
      </p>
      {!processed && (
        <div className="flex gap-2">
          {item.type === 'agent_proposed_todo' && (
            <>
              <Button variant="secondary" size="sm" onClick={onAccept}>
                {t.inbox.accept}
              </Button>
              <Button variant="plain" size="sm" onClick={onIgnore}>
                {t.inbox.ignore}
              </Button>
            </>
          )}
          {item.type === 'agent_result' && (
            <>
              {onView && (
                <Button variant="secondary" size="sm" onClick={onView}>
                  {t.inbox.viewResult}
                </Button>
              )}
              <Button variant="plain" size="sm" onClick={onIgnore}>
                {t.inbox.close}
              </Button>
            </>
          )}
          {item.type === 'agent_confirmation' && (
            <>
              {onView && (
                <Button variant="secondary" size="sm" onClick={onView}>
                  {t.inbox.viewResult}
                </Button>
              )}
              <Button variant="plain" size="sm" onClick={onIgnore}>
                {t.inbox.cancelTask}
              </Button>
            </>
          )}
          {item.type === 'agent_error' && (
            <>
              {onView && (
                <Button variant="secondary" size="sm" onClick={onView}>
                  {t.inbox.retry}
                </Button>
              )}
              <Button variant="plain" size="sm" onClick={onIgnore}>
                {t.inbox.close}
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
