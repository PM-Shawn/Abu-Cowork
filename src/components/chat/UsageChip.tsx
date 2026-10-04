import { useEffect, useState } from 'react';
import { useI18n } from '@/i18n';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { queryUsageConversation, type UsageAggregate } from '@/core/usage/usageLedgerClient';

/**
 * 会话用量小标签。数据来自主进程的用量账本，按会话 id 取合计。
 */

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** 会话还在跑的时候数字会变，所以定期取一次。 */
const REFRESH_INTERVAL_MS = 15_000;

export default function UsageChip({ conversationId }: { conversationId: string }) {
  const { t } = useI18n();
  const [usage, setUsage] = useState<UsageAggregate | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const result = await queryUsageConversation(conversationId);
      // 取不到就保留上一次的数字，不清零。
      if (alive && result.available) setUsage(result.totals);
    };
    void load();
    const timer = setInterval(() => void load(), REFRESH_INTERVAL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [conversationId]);

  if (!usage || usage.attempts === 0) return null;

  const total = usage.inputKnownSum + usage.outputKnownSum;
  const hasCacheData = usage.cacheReadKnownSum > 0 || usage.cacheWriteKnownSum > 0;

  const bodyLine = [
    `${t.chat.usageChipInput}: ${formatTokens(usage.inputKnownSum)}${hasCacheData ? ` (${t.chat.usageChipCache} ${formatTokens(usage.cacheReadKnownSum)})` : ''}`,
    `${t.chat.usageChipOutput}: ${formatTokens(usage.outputKnownSum)}`,
    `${usage.attempts} ${t.chat.usageChipRequests}`,
  ].join(' · ');

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="inline-flex items-center gap-1 text-caption text-[var(--abu-text-muted)] tabular-nums select-none cursor-default"
          >
            <span>{formatTokens(total)}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="flex flex-col items-start gap-0.5 max-w-xs">
          <span className="text-caption opacity-60 leading-tight">
            {t.chat.usageChipSubtitle}
          </span>
          <span className="leading-tight">{bodyLine}</span>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
