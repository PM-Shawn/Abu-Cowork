import { useState, useRef, useEffect } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { useTriggerStore } from '@/stores/triggerStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useI18n } from '@/i18n';
import { ChevronRight, Zap, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { TriggerRun } from '@/types/trigger';

const MAX_VISIBLE_RUNS = 5;

function formatRunDate(timestamp: number): string {
  const d = new Date(timestamp);
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  return `${month}/${day} ${h}:${m}`;
}

function RunStatusDot({ status }: { status: TriggerRun['status'] }) {
  if (status === 'running') {
    return <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse shrink-0" />;
  }
  if (status === 'completed') {
    return <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />;
  }
  if (status === 'error') {
    return <span className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" />;
  }
  if (status === 'filtered' || status === 'debounced') {
    return <span className="w-1.5 h-1.5 rounded-full bg-neutral-300 shrink-0" />;
  }
  return null;
}

export default function TriggerSection() {
  const { t } = useI18n();
  const triggers = useTriggerStore((s) => s.triggers);
  const setSelectedTriggerId = useTriggerStore((s) => s.setSelectedTriggerId);
  const removeRun = useTriggerStore((s) => s.removeRun);
  const conversations = useChatStore((s) => s.conversations);
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const switchConversation = useChatStore((s) => s.switchConversation);
  const deleteConversation = useChatStore((s) => s.deleteConversation);
  const setViewMode = useSettingsStore((s) => s.setViewMode);
  const viewMode = useSettingsStore((s) => s.viewMode);

  const [sectionOpen, setSectionOpen] = useState(true);
  const [expandedTriggers, setExpandedTriggers] = useState<Record<string, boolean>>({});

  // Context menu for child runs
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    triggerId: string;
    run: TriggerRun;
  } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!contextMenu) return;
    const handleClick = () => setContextMenu(null);
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [contextMenu]);

  // Only show triggers that have runs with conversations (skip filtered/debounced-only)
  const triggersWithRuns = Object.values(triggers).filter((trigger) =>
    trigger.runs.some((r) => r.conversationId && conversations[r.conversationId])
  );
  if (triggersWithRuns.length === 0) return null;

  const toggleTrigger = (triggerId: string) => {
    setExpandedTriggers((prev) => ({ ...prev, [triggerId]: !prev[triggerId] }));
  };

  const handleParentClick = (triggerId: string) => {
    setSelectedTriggerId(triggerId);
    setViewMode('trigger');
  };

  const handleRunClick = (conversationId: string) => {
    if (conversations[conversationId]) {
      switchConversation(conversationId);
      setViewMode('chat');
    }
  };

  const handleRunContextMenu = (
    e: React.MouseEvent,
    triggerId: string,
    run: TriggerRun
  ) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, triggerId, run });
  };

  const handleArchiveRun = () => {
    if (!contextMenu) return;
    const { triggerId, run } = contextMenu;
    if (conversations[run.conversationId]) {
      deleteConversation(run.conversationId);
    }
    removeRun(triggerId, run.id);
    setContextMenu(null);
  };

  const handleViewTrigger = () => {
    if (!contextMenu) return;
    setSelectedTriggerId(contextMenu.triggerId);
    setViewMode('trigger');
    setContextMenu(null);
  };

  return (
    <div className="px-4 pb-1">
      {/* Section header */}
      <button
        onClick={() => setSectionOpen(!sectionOpen)}
        className="flex items-center gap-1 w-full px-2 py-1 text-[12px] font-medium text-[#656358] hover:text-[#29261b]"
      >
        <ChevronRight
          className={cn('h-3 w-3 transition-transform', sectionOpen && 'rotate-90')}
        />
        <span>{t.sidebar.triggered}</span>
      </button>

      {sectionOpen && (
        <div className="space-y-0.5">
          {triggersWithRuns.map((trigger) => {
            const isExpanded = expandedTriggers[trigger.id] ?? true;
            // Only show runs that have conversations
            const runsWithConv = trigger.runs.filter(
              (r) => r.conversationId && conversations[r.conversationId]
            );
            const visibleRuns = isExpanded
              ? runsWithConv.slice(0, MAX_VISIBLE_RUNS)
              : [];

            return (
              <div key={trigger.id}>
                {/* Parent trigger row */}
                <div className="flex items-center gap-1 px-2">
                  <button
                    onClick={() => toggleTrigger(trigger.id)}
                    className="shrink-0 p-0.5 text-[#656358] hover:text-[#29261b]"
                  >
                    <ChevronRight
                      className={cn('h-3 w-3 transition-transform', isExpanded && 'rotate-90')}
                    />
                  </button>
                  <button
                    onClick={() => handleParentClick(trigger.id)}
                    className={cn(
                      'flex-1 min-w-0 text-left py-1 rounded-md text-[12px] truncate',
                      'text-[#3d3929] hover:text-[#29261b]'
                    )}
                  >
                    <span className="truncate">{trigger.name}</span>
                  </button>
                </div>

                {/* Child run items */}
                {isExpanded && (
                  <div className="ml-5 space-y-px">
                    {visibleRuns.map((run) => {
                      const convExists = !!conversations[run.conversationId];
                      const isActive = run.conversationId === activeConversationId && viewMode === 'chat';
                      const label = `${formatRunDate(run.startedAt)} - ${trigger.name}`;

                      return (
                        <button
                          key={run.id}
                          onClick={() => handleRunClick(run.conversationId)}
                          onContextMenu={(e) => handleRunContextMenu(e, trigger.id, run)}
                          disabled={!convExists}
                          className={cn(
                            'flex items-center gap-1.5 w-full px-2 py-1 rounded-md text-[12px] truncate transition-colors',
                            isActive
                              ? 'bg-white shadow-sm text-[#29261b]'
                              : convExists
                                ? 'text-[#656358] hover:bg-[#e8e5de] hover:text-[#3d3929]'
                                : 'text-[#b0ad9f] cursor-not-allowed'
                          )}
                        >
                          <RunStatusDot status={run.status} />
                          <span className="truncate">{label}</span>
                        </button>
                      );
                    })}
                    {runsWithConv.length > MAX_VISIBLE_RUNS && (
                      <button
                        onClick={() => toggleTrigger(trigger.id)}
                        className="w-full px-2 py-0.5 text-[11px] text-[#999] hover:text-[#656358] text-left"
                      >
                        +{runsWithConv.length - MAX_VISIBLE_RUNS} more
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Context menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-50 bg-white rounded-lg shadow-lg border border-[#e8e4dd] py-1 min-w-[160px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            onClick={handleViewTrigger}
            className="flex items-center gap-2 w-full px-3 py-1.5 text-[13px] text-[#3d3929] hover:bg-[#f0ede6]"
          >
            <Zap className="h-3.5 w-3.5" />
            {t.sidebar.viewTrigger}
          </button>
          <button
            onClick={handleArchiveRun}
            className="flex items-center gap-2 w-full px-3 py-1.5 text-[13px] text-red-500 hover:bg-[#f0ede6]"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t.sidebar.archiveTriggerRun}
          </button>
        </div>
      )}
    </div>
  );
}
