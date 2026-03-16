import { useChatStore } from '../../stores/chatStore';
import { useSettingsStore, AVAILABLE_MODELS, getEffectiveModel } from '../../stores/settingsStore';
import { useI18n } from '@/i18n';
import { Loader2, Wrench, Zap } from 'lucide-react';
import { useState, useEffect } from 'react';

/**
 * Hook to track elapsed time since a timestamp
 */
function useElapsedTime(startTime: number | null): number {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!startTime) {
      setElapsed(0);
      return;
    }

    // Initial calculation
    setElapsed(Math.floor((Date.now() - startTime) / 1000));

    // Update every second
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);

    return () => clearInterval(interval);
  }, [startTime]);

  return elapsed;
}

export default function StatusBar() {
  const agentStatus = useChatStore((s) => s.agentStatus);
  const currentTool = useChatStore((s) => s.currentTool);
  const thinkingStartTime = useChatStore((s) => s.thinkingStartTime);
  const currentUsage = useChatStore((s) => s.currentUsage);
  const provider = useSettingsStore((s) => s.provider);
  const model = useSettingsStore((s) => s.model);
  const effectiveModel = getEffectiveModel(useSettingsStore.getState());
  const modelLabel = AVAILABLE_MODELS[provider]?.find((m) => m.id === model)?.label ?? effectiveModel;
  const { t } = useI18n();

  // Track thinking time
  const thinkingElapsed = useElapsedTime(
    agentStatus === 'thinking' || agentStatus === 'streaming' ? thinkingStartTime : null
  );

  // Format token usage with cache info
  const tokenDisplay = currentUsage ? formatTokenUsage(currentUsage) : null;

  return (
    <div className="flex items-center justify-between px-4 py-1.5 border-t border-zinc-800 bg-zinc-900/50 text-xs text-zinc-500">
      {/* Left: Agent status */}
      <div className="flex items-center gap-2">
        {agentStatus === 'idle' ? (
          <>
            <Zap className="w-3 h-3 text-green-500" />
            <span>{t.status.ready}</span>
          </>
        ) : agentStatus === 'tool-calling' ? (
          <>
            <Wrench className="w-3 h-3 text-amber-400 animate-pulse" />
            <span className="text-amber-400">{t.status.usingTool} {currentTool}</span>
          </>
        ) : (
          <>
            <Loader2 className="w-3 h-3 animate-spin text-blue-400" />
            <span className="text-blue-400">
              {agentStatus === 'thinking' ? t.status.thinking : t.status.responding}
              {thinkingElapsed > 0 && (
                <span className="ml-1 text-blue-300">({thinkingElapsed}s)</span>
              )}
            </span>
          </>
        )}
      </div>

      {/* Right: Token usage + Model info */}
      <div className="flex items-center gap-3">
        {tokenDisplay && (
          <span className="text-zinc-500" title={tokenDisplay.tooltip}>
            {tokenDisplay.text}
          </span>
        )}
        <span>{modelLabel}</span>
      </div>
    </div>
  );
}

function formatTokenUsage(usage: { inputTokens: number; outputTokens: number; cacheCreationInputTokens?: number; cacheReadInputTokens?: number }): { text: string; tooltip: string } {
  const { inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens } = usage;

  const cached = (cacheReadInputTokens ?? 0);
  const hasCacheInfo = cached > 0 || (cacheCreationInputTokens ?? 0) > 0;

  const formatNum = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

  const text = hasCacheInfo
    ? `In: ${formatNum(inputTokens)} (${formatNum(cached)} cached) · Out: ${formatNum(outputTokens)}`
    : `In: ${formatNum(inputTokens)} · Out: ${formatNum(outputTokens)}`;

  const tooltip = [
    `Input: ${inputTokens}`,
    `Output: ${outputTokens}`,
    cacheCreationInputTokens ? `Cache created: ${cacheCreationInputTokens}` : null,
    cacheReadInputTokens ? `Cache read: ${cacheReadInputTokens}` : null,
  ].filter(Boolean).join('\n');

  return { text, tooltip };
}
