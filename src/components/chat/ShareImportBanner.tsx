/**
 * ShareImportBanner — renders at the top of a conversation that was imported
 * from a shared `.abu.json` bundle. Signals read-only state to the user and
 * pairs with a disabled ChatInput.
 */

import { Eye } from 'lucide-react';
import { useI18n, format } from '@/i18n';
import type { Conversation } from '@/types';

interface ShareImportBannerProps {
  conversation: Conversation;
}

export default function ShareImportBanner({ conversation }: ShareImportBannerProps) {
  const { t } = useI18n();
  if (!conversation.readOnly) return null;

  const importedAt = conversation.importedFrom?.importedAt;
  const dateLabel = importedAt
    ? new Date(importedAt).toLocaleDateString()
    : null;

  return (
    <div
      role="status"
      className="shrink-0 flex items-center gap-2 px-6 md:px-10 py-1.5 bg-[var(--abu-bg-subtle)] border-b border-[var(--abu-border)] text-[13px]"
    >
      <Eye className="h-3.5 w-3.5 text-[var(--abu-clay)]" />
      <span className="font-medium text-[var(--abu-text-primary)]">
        {t.chat.readOnlyBannerTitle}
      </span>
      <span className="text-[var(--abu-text-placeholder)]">·</span>
      <span className="text-[var(--abu-text-tertiary)] truncate">
        {t.chat.readOnlyBannerSubtitle}
      </span>
      {dateLabel && (
        <>
          <span className="text-[var(--abu-text-placeholder)] ml-auto shrink-0">·</span>
          <span className="text-[var(--abu-text-muted)] shrink-0">
            {format(t.chat.readOnlyImportedAt, { date: dateLabel })}
          </span>
        </>
      )}
    </div>
  );
}
