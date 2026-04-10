import { useSyncExternalStore } from 'react';
import { Monitor, Square } from 'lucide-react';
import { subscribeCUStatus, getCUStatusSnapshot } from '@/core/agent/computerUseStatus';

/**
 * Floating console UI shown when Abu is in floating mode during Computer Use.
 * Replaces the normal chat UI with a compact control panel:
 * - Live screenshot preview
 * - Current action description
 * - Step counter
 * - Pause / Stop controls
 */
export default function FloatingConsole({ onStop }: { onStop: () => void }) {
  const cuState = useSyncExternalStore(subscribeCUStatus, getCUStatusSnapshot);

  // Only render when in floating mode and active
  if (!cuState.isFloating || cuState.status === 'idle') return null;

  return (
    <div className="flex flex-col h-full bg-[var(--abu-bg-base)] overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-blue-500/20 bg-blue-500/5">
        <div className="flex items-center gap-2 text-blue-400">
          <Monitor className="h-4 w-4 animate-pulse" />
          <span className="text-sm font-medium">正在操控电脑</span>
        </div>
        <span className="text-xs text-[var(--abu-text-muted)]">
          第 {cuState.stepCount} 步
        </span>
      </div>

      {/* Screenshot Preview */}
      <div className="flex-1 p-3 overflow-hidden">
        {cuState.latestScreenshot ? (
          <img
            src={`data:image/png;base64,${cuState.latestScreenshot}`}
            alt="Screen"
            className="w-full h-full object-contain rounded border border-white/10"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-[var(--abu-text-muted)] text-xs">
            等待截图...
          </div>
        )}
      </div>

      {/* Current Action */}
      {cuState.currentAction && (
        <div className="px-4 py-2 border-t border-white/5">
          <p className="text-xs text-[var(--abu-text-muted)] truncate">
            {cuState.currentAction}
          </p>
        </div>
      )}

      {/* Controls */}
      <div className="flex items-center justify-center gap-3 px-4 py-3 border-t border-white/10">
        <button
          onClick={onStop}
          className="flex items-center gap-1.5 px-4 py-2 text-sm text-red-400 hover:text-red-300 bg-red-500/10 hover:bg-red-500/20 rounded-lg transition-colors"
        >
          <Square className="h-3.5 w-3.5" />
          停止
        </button>
      </div>
    </div>
  );
}
