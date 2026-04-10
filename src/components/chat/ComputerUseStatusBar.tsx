import { useSyncExternalStore } from 'react';
import { Monitor, Square } from 'lucide-react';
import { subscribeCUStatus, getCUStatusSnapshot } from '@/core/agent/computerUseStatus';

export default function ComputerUseStatusBar({ onStop }: { onStop?: () => void }) {
  const status = useSyncExternalStore(subscribeCUStatus, getCUStatusSnapshot);

  if (status.status !== 'active') return null;

  return (
    <div className="flex items-center justify-between px-4 py-2 bg-blue-500/10 border-b border-blue-500/20 text-sm">
      <div className="flex items-center gap-2 text-blue-400">
        <Monitor className="h-4 w-4 animate-pulse" />
        <span>
          正在操控电脑
          {status.stepCount > 0 && ` · 第 ${status.stepCount} 步`}
        </span>
      </div>
      {onStop && (
        <button
          onClick={onStop}
          className="flex items-center gap-1 px-2 py-1 text-xs text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded transition-colors"
        >
          <Square className="h-3 w-3" />
          停止
        </button>
      )}
    </div>
  );
}
