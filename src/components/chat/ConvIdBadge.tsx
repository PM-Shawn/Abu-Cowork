import { useState, useCallback } from 'react';
import { useI18n } from '@/i18n';
import { Check, Copy } from 'lucide-react';

export default function ConvIdBadge({ conversationId }: { conversationId: string }) {
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
    <button
      type="button"
      onClick={handleCopy}
      title={t.chat.copyConvIdTooltip}
      className="inline-flex items-center gap-1 text-[11px] text-[var(--abu-text-muted)] hover:text-[var(--abu-text-tertiary)] transition-colors font-mono tabular-nums"
      aria-label={t.chat.copyConvIdTooltip}
    >
      <span>#{short}</span>
      {copied ? (
        <>
          <Check className="h-3 w-3" />
          <span className="font-sans">{t.chat.copyConvIdCopied}</span>
        </>
      ) : (
        <Copy className="h-3 w-3 opacity-60" />
      )}
    </button>
  );
}
