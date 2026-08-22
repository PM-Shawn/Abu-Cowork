import { useMemo } from 'react';
import { Loader2 } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n, format } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore, getEffectiveModel } from '@/stores/settingsStore';
import { calculateWarningLevel, getDisplayPercent } from '@/core/context/autoCompact';
import { estimateMessageTokens } from '@/core/context/tokenEstimator';
import { resolveEffectiveContextWindow } from '@/core/llm/modelCapabilities';
import { cn } from '@/lib/utils';

const RING_SIZE = 22;
const RING_RADIUS = 8;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const VIEWBOX = '0 0 22 22';
const CENTER = 11;

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
      const anchor = publishedUsage.messageCountAtPublish;
      // `messages.length < anchor` means history shrank under us (revert / delete).
      // Add nothing rather than guess; the next turn republishes an exact anchor.
      const tail = typeof anchor === 'number' && messages && messages.length > anchor
        ? messages.slice(anchor)
        : [];
      const tokensUsed = publishedUsage.tokensUsed
        + (tail.length > 0 ? estimateMessageTokens(tail) : 0);
      const tokensMax = publishedUsage.tokensMax;
      return { percent: getDisplayPercent(tokensUsed, tokensMax), tokensUsed, tokensMax };
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
            {isCompressing ? (
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
            )}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="flex flex-col items-start gap-0.5">
          {!isCompressing && (
            <span className="text-caption opacity-60 leading-tight">
              {t.chat.contextTooltipSubtitle}
            </span>
          )}
          <span className="leading-tight">{tooltipText}</span>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
