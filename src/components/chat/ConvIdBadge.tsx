import { memo, useState, useCallback } from 'react';
import { useI18n } from '@/i18n';
import { IconButton } from '@/components/ds/button';
import { AppIcons } from '@/components/ds/icons';

function ConvIdBadge({ conversationId }: { conversationId: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const short = conversationId.slice(0, 8);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(conversationId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard may be unavailable in some contexts; silently fail */
    }
  }, [conversationId]);

  return (
    <span className="inline-flex items-center gap-1">
      <span className="font-code text-caption text-label-tertiary tabular-nums">#{short}</span>
      <IconButton
        size="sm"
        icon={copied ? AppIcons.done : AppIcons.copy}
        label={copied ? t.chat.copyConvIdCopied : t.chat.copyConvIdTooltip}
        onClick={handleCopy}
      />
      {copied && <span className="text-caption text-label-tertiary">{t.chat.copyConvIdCopied}</span>}
    </span>
  );
}

// Sits under the composer; ChatView re-renders on every streamed token, the badge only when its conversation changes.
export default memo(ConvIdBadge);
