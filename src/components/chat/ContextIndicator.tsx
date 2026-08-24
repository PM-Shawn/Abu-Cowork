import { useMemo } from 'react';
import { Loader2 } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n, format } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore, getEffectiveModel } from '@/stores/settingsStore';
import { calculateWarningLevel, getDisplayPercent } from '@/core/context/autoCompact';
import { isCompactBoundary } from '@/core/context/compactBoundary';
import { estimateMessageTokens } from '@/core/context/tokenEstimator';
import {
  BUCKET_KEYS,
  distributeWithConservation,
  type UsageBreakdownBuckets,
} from '@/core/context/usageBreakdown';
import { resolveEffectiveContextWindow } from '@/core/llm/modelCapabilities';
import { cn } from '@/lib/utils';

const RING_SIZE = 22;
const RING_RADIUS = 8;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const VIEWBOX = '0 0 22 22';
const CENTER = 11;

type BreakdownKey = (typeof BUCKET_KEYS)[number];

/* eslint-disable no-restricted-syntax -- five arbitrary context categories need
   distinct hues; these are categorical markers, not semantic status colors. */
const BREAKDOWN_COLORS: Record<BreakdownKey, string> = {
  systemPrompt: 'bg-blue-500',
  tools: 'bg-amber-500',
  mcp: 'bg-purple-500',
  skills: 'bg-teal-500',
  conversation: 'bg-[var(--abu-clay)]',
};
/* eslint-enable no-restricted-syntax */

// Fallback overhead for the only case with no published usage at all: a
// conversation reopened from history that hasn't run a turn since app start.
// Picked to underestimate rather than overestimate — better to slightly
// understate the water level than to scare the user with a false positive.
const FALLBACK_OVERHEAD_TOKENS = 5000;

function formatK(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function levelColorClass(level: 0 | 1 | 2 | 3): string {
  switch (level) {
    case 0: return 'text-[var(--abu-text-muted)]';
    case 1: return 'text-[var(--abu-warning)]';
    case 2: return 'text-[var(--abu-warning)]';
    case 3: return 'text-[var(--abu-danger)] animate-pulse';
  }
}

function isValidBreakdown(
  breakdown: (UsageBreakdownBuckets & { version: number }) | undefined,
  tokensUsed: number,
  tokensMax: number,
): breakdown is UsageBreakdownBuckets & { version: 1 } {
  if (
    breakdown?.version !== 1
    || !Number.isSafeInteger(tokensUsed)
    || tokensUsed < 0
    || !Number.isSafeInteger(tokensMax)
    || tokensMax <= 0
  ) {
    return false;
  }

  let bucketTotal = 0;
  for (const key of BUCKET_KEYS) {
    const value = breakdown[key];
    if (!Number.isSafeInteger(value) || value < 0) return false;
    bucketTotal += value;
    if (!Number.isSafeInteger(bucketTotal)) return false;
  }
  return bucketTotal === tokensUsed;
}

export default function ContextIndicator({ conversationId }: { conversationId: string }) {
  const { t } = useI18n();
  const publishedUsage = useChatStore((s) => s.conversations[conversationId]?.contextUsage);
  const messages = useChatStore((s) => s.conversations[conversationId]?.messages);
  const isCompressing = useChatStore((s) => s.conversations[conversationId]?.isCompressing ?? false);
  const userContextWindow = useSettingsStore((s) => s.contextWindowSize);
  const activeModelId = useSettingsStore(getEffectiveModel);

  // agentLoop's published snapshot is the truth: it measures the payload actually
  // sent, so it already reflects compaction, micro-compaction and the hard budget
  // gate. On top of it we estimate ONLY the messages appended since the publish
  // anchor — the assistant reply currently streaming — which keeps the ring live.
  //
  // Re-counting `messages` wholesale (the previous behaviour) silently undid every
  // compression the loop had applied, so a long conversation climbed past its own
  // window and rendered "108% 已用" while the real request fit comfortably.
  //
  // Only when nothing has been published at all — a history conversation reopened
  // after restart — do we fall back to counting the raw history, since there is no
  // better number available and a blank ring is worse than a rough one.
  const usage = useMemo(() => {
    if (publishedUsage) {
      // Validate the persisted/imported snapshot before any arithmetic. JSON can
      // turn invalid numeric values into `null`, and JavaScript would otherwise
      // coerce `null + tailTokens` to a plausible zero; a positive tail could
      // similarly hide a negative published value.
      const publishedBreakdown = isValidBreakdown(
        publishedUsage.breakdown,
        publishedUsage.tokensUsed,
        publishedUsage.tokensMax,
      ) ? publishedUsage.breakdown : undefined;
      const anchor = publishedUsage.messageCountAtPublish;
      // `messages.length < anchor` means history shrank under us (revert / delete).
      // Add nothing rather than guess; the next turn republishes an exact anchor.
      const tail = typeof anchor === 'number' && messages && messages.length > anchor
        ? messages.slice(anchor).filter((message) => !isCompactBoundary(message))
        : [];
      const tailTokens = tail.length > 0 ? estimateMessageTokens(tail) : 0;
      const tokensUsed = publishedUsage.tokensUsed + tailTokens;
      const tokensMax = publishedUsage.tokensMax;
      const breakdown = publishedBreakdown
        ? {
            ...publishedBreakdown,
            conversation: publishedBreakdown.conversation + tailTokens,
          }
        : undefined;
      return {
        percent: getDisplayPercent(tokensUsed, tokensMax),
        tokensUsed,
        tokensMax,
        breakdown,
      };
    }
    if (!messages || messages.length === 0) return undefined;
    // Resolve the denominator locally so the indicator never overstates capacity
    // (e.g. a 200k user setting on a 128k mimo model).
    const tokensUsed = FALLBACK_OVERHEAD_TOKENS + estimateMessageTokens(messages);
    const tokensMax = resolveEffectiveContextWindow(activeModelId, userContextWindow);
    return { percent: getDisplayPercent(tokensUsed, tokensMax), tokensUsed, tokensMax };
  }, [messages, publishedUsage, userContextWindow, activeModelId]);

  const level: 0 | 1 | 2 | 3 = usage
    ? calculateWarningLevel(usage.tokensUsed, usage.tokensMax)
    : 0;

  // `usage.percent` is already clamped to 0–100 by getDisplayPercent.
  const dashOffset = usage
    ? RING_CIRCUMFERENCE * (1 - usage.percent / 100)
    : RING_CIRCUMFERENCE;

  const tooltipText = isCompressing
    ? t.chat.contextTooltipCompressing
    : usage
      ? format(t.chat.contextTooltipUsage, {
          percent: String(usage.percent),
          used: formatK(usage.tokensUsed),
          max: formatK(usage.tokensMax),
        })
      : t.chat.contextTooltipIdle;

  const usageSummaryText = usage
    ? format(t.chat.contextTooltipUsage, {
        percent: String(usage.percent),
        used: formatK(usage.tokensUsed),
        max: formatK(usage.tokensMax),
      })
    : t.chat.contextTooltipIdle;

  const breakdown = usage && isValidBreakdown(
    usage.breakdown,
    usage.tokensUsed,
    usage.tokensMax,
  ) ? usage.breakdown : undefined;
  const breakdownPercents = breakdown && usage
    ? distributeWithConservation(breakdown, usage.percent)
    : undefined;
  const breakdownRows = breakdown && breakdownPercents
    ? BUCKET_KEYS.map((key) => ({
        key,
        tokens: breakdown[key],
        percent: breakdownPercents[key],
        label: t.chat.contextBreakdown[key],
      }))
    : [];
  const freePercent = usage ? Math.max(0, 100 - usage.percent) : 100;
  const freeTokens = usage ? Math.max(0, usage.tokensMax - usage.tokensUsed) : 0;

  const indicatorGraphic = isCompressing ? (
    <Loader2 className="text-purple-400 animate-spin" style={{ width: RING_SIZE, height: RING_SIZE }} />
  ) : (
    <svg width={RING_SIZE} height={RING_SIZE} viewBox={VIEWBOX}>
      <circle
        cx={CENTER} cy={CENTER} r={RING_RADIUS}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        className="text-[var(--abu-text-muted)] opacity-30"
      />
      {usage && (
        <circle
          cx={CENTER} cy={CENTER} r={RING_RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={RING_CIRCUMFERENCE}
          strokeDashoffset={dashOffset}
          transform={`rotate(-90 ${CENTER} ${CENTER})`}
          className={cn('transition-[stroke-dashoffset,color] duration-300', levelColorClass(level))}
        />
      )}
    </svg>
  );

  const tooltipContent = (
    <TooltipContent side="top" className="flex flex-col items-start gap-0.5">
      {!isCompressing && (
        <span className="text-caption opacity-60 leading-tight">
          {t.chat.contextTooltipSubtitle}
        </span>
      )}
      <span className="leading-tight">{tooltipText}</span>
    </TooltipContent>
  );

  if (!breakdown || !breakdownPercents || !usage) {
    return (
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              aria-label={tooltipText}
              data-testid="context-indicator"
              className="inline-flex items-center justify-center select-none"
              style={{ width: RING_SIZE, height: RING_SIZE }}
            >
              {indicatorGraphic}
            </span>
          </TooltipTrigger>
          {tooltipContent}
        </Tooltip>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider delayDuration={300}>
      <Popover>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label={tooltipText}
                data-testid="context-indicator"
                className={cn(
                  'inline-flex items-center justify-center select-none cursor-pointer rounded-full border-0 bg-transparent p-0',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--abu-clay-ring)]',
                )}
                style={{ width: RING_SIZE, height: RING_SIZE }}
              >
                {indicatorGraphic}
              </button>
            </PopoverTrigger>
          </TooltipTrigger>
          {tooltipContent}
        </Tooltip>

        <PopoverContent
          side="top"
          align="end"
          className="w-80 space-y-3"
          aria-label={t.chat.contextBreakdown.title}
          data-testid="context-breakdown-popover"
          data-tokens-used={usage.tokensUsed}
        >
          <div className="space-y-0.5">
            <h3 className="text-h-xs text-[var(--abu-text-primary)]">
              {t.chat.contextBreakdown.title}
            </h3>
            <p
              className="text-caption text-[var(--abu-text-muted)]"
              data-testid="context-breakdown-header"
            >
              {usageSummaryText}
            </p>
          </div>

          <div
            role="img"
            aria-label={`${t.chat.contextBreakdown.free}: ${formatK(freeTokens)} · ${freePercent}%`}
            className="flex h-2 w-full overflow-hidden rounded-full bg-[var(--abu-bg-pressed)]"
            data-testid="context-breakdown-bar"
          >
            {breakdownRows.map((row) => (
              <span
                key={row.key}
                aria-hidden="true"
                className={cn('h-full shrink-0', BREAKDOWN_COLORS[row.key])}
                style={{ width: `${row.percent}%` }}
              />
            ))}
          </div>

          <ul className="space-y-1.5">
            {breakdownRows.map((row) => (
              <li
                key={row.key}
                className="flex items-center justify-between gap-4 text-minor"
                data-testid={`context-breakdown-row-${row.key}`}
                data-tokens={row.tokens}
              >
                <span className="flex min-w-0 items-center gap-2 text-[var(--abu-text-secondary)]">
                  <span
                    aria-hidden="true"
                    className={cn('size-2 shrink-0 rounded-full', BREAKDOWN_COLORS[row.key])}
                  />
                  <span className="truncate">{row.label}</span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5 text-caption text-[var(--abu-text-muted)]">
                  <span data-testid={`context-breakdown-tokens-${row.key}`}>
                    {formatK(row.tokens)}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span data-testid={`context-breakdown-percent-${row.key}`}>
                    {row.percent}%
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </PopoverContent>
      </Popover>
    </TooltipProvider>
  );
}
