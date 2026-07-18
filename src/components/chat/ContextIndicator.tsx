import { useMemo } from 'react';
import { Loader2 } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n, format } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore, getEffectiveModel } from '@/stores/settingsStore';
import { calculateWarningLevel } from '@/core/context/autoCompact';
import { estimateMessageTokens } from '@/core/context/tokenEstimator';
import { resolveEffectiveContextWindow } from '@/core/llm/modelCapabilities';
import { cn } from '@/lib/utils';

const RING_SIZE = 22;
const RING_RADIUS = 8;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const VIEWBOX = '0 0 22 22';
const CENTER = 11;

// Fallback when agentLoop hasn't published `overhead` yet (first turn of a fresh
// conversation, or right after app restart for a history conversation). Picked to
// underestimate rather than overestimate — better to slightly understate the water
// level than to scare the user with a false-positive warning.
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

  // Live derive: overhead (from agentLoop's last publish, or fallback) + current
  // message-tokens. This keeps the ring in sync with streaming output and with
  // history-conversation reopens, where the published `contextUsage` is stale or
  // absent but `messages` is authoritative.
  // For the denominator we trust the published `tokensMax` first (agentLoop already
  // clamps to the model's real cap); otherwise resolve it locally so the indicator
  // never overstates capacity (e.g. 200k user-setting on a 128k mimo model).
  const derivedUsage = useMemo(() => {
    if (!messages || messages.length === 0) return null;
    const overhead = publishedUsage?.overhead ?? FALLBACK_OVERHEAD_TOKENS;
    const tokensUsed = overhead + estimateMessageTokens(messages);
    const tokensMax = publishedUsage?.tokensMax
      ?? resolveEffectiveContextWindow(activeModelId, userContextWindow);
    const percent = tokensMax > 0 ? Math.round((tokensUsed / tokensMax) * 100) : 0;
    return { percent, tokensUsed, tokensMax };
  }, [messages, publishedUsage?.overhead, publishedUsage?.tokensMax, userContextWindow, activeModelId]);

  const usage = derivedUsage ?? publishedUsage;

  const level: 0 | 1 | 2 | 3 = usage
    ? calculateWarningLevel(usage.tokensUsed, usage.tokensMax)
    : 0;

  const dashOffset = usage
    ? RING_CIRCUMFERENCE * (1 - Math.min(usage.percent, 100) / 100)
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
