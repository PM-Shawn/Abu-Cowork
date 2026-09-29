/**
 * ImportedBadge — small download tag pinned before a conversation title
 * in the sidebar, signaling that the conversation came from a `.abu.json`
 * share bundle someone else exported. The recipient can still continue
 * chatting; the badge only communicates provenance.
 *
 * Rendered conditionally by the caller based on `ConversationMeta.importedFrom`.
 */

import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { Tag } from '@/components/ds/tag';
import { Tooltip } from '@/components/ds/tooltip';
import { useI18n, format } from '@/i18n';

interface ImportedBadgeProps {
  importedAt?: number;
}

export default function ImportedBadge({ importedAt }: ImportedBadgeProps) {
  const { t } = useI18n();
  const dateLabel = importedAt ? new Date(importedAt).toLocaleDateString() : null;
  const title = dateLabel
    ? format(t.share.importedBadgeWithDate, { date: dateLabel })
    : t.share.importedBadge;
  return (
    <Tooltip content={title}>
      <span className="inline-flex shrink-0">
        <Tag>
          <Icon icon={AppIcons.download} size="sm" label={title} />
        </Tag>
      </span>
    </Tooltip>
  );
}
