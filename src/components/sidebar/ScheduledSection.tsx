import { useState, useRef, useEffect } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { useScheduleStore } from '@/stores/scheduleStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useI18n } from '@/i18n';
import { ChevronRight, Clock, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ScheduledTaskRun } from '@/types/schedule';

const MAX_VISIBLE_RUNS = 5;

function formatRunDate(timestamp: number): string {
  const d = new Date(timestamp);
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  return `${month}/${day} ${h}:${m}`;
}

function RunStatusDot({ status, startedAt }: { status: ScheduledTaskRun['status']; startedAt: number }) {
  const [hidden, setHidden] = useState(() => {
    // If status is already terminal and old enough, hide immediately
    if (status === 'completed' && Date.now() - startedAt > 3000) return true;
    if (status === 'error' && Date.now() - startedAt > 10000) return true;
    return false;
  });

  useEffect(() => {
    if (status === 'completed') {
      const timer = setTimeout(() => setHidden(true), 3000);
      return () => clearTimeout(timer);
    }
    if (status === 'error') {
      const timer = setTimeout(() => setHidden(true), 10_000);
      return () => clearTimeout(timer);
    }
    setHidden(false);
  }, [status]);

  if (hidden) return null;

  if (status === 'running') {
    return <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse shrink-0" />;
  }
  if (status === 'completed') {
    return <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />;
  }
  if (status === 'error') {
    return <span className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" />;
  }
  return null;
}

export default function ScheduledSection() {
  const { t } = useI18n();
  const tasks = useScheduleStore((s) => s.tasks);
  const setSelectedTaskId = useScheduleStore((s) => s.setSelectedTaskId);
  const removeRun = useScheduleStore((s) => s.removeRun);
  const conversations = useChatStore((s) => s.conversations);
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const switchConversation = useChatStore((s) => s.switchConversation);
  const deleteConversation = useChatStore((s) => s.deleteConversation);
  const setViewMode = useSettingsStore((s) => s.setViewMode);
  const viewMode = useSettingsStore((s) => s.viewMode);

  const [sectionOpen, setSectionOpen] = useState(false);
  const [expandedTasks, setExpandedTasks] = useState<Record<string, boolean>>({});

  // Context menu for child runs
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    taskId: string;
    run: ScheduledTaskRun;
  } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  // Close context menu when clicking outside
  useEffect(() => {
    if (!contextMenu) return;
    const handleClick = () => setContextMenu(null);
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [contextMenu]);

  // Only show tasks that have runs
  const tasksWithRuns = Object.values(tasks).filter((task) => task.runs.length > 0);
  if (tasksWithRuns.length === 0) return null;

  const toggleTask = (taskId: string) => {
    setExpandedTasks((prev) => ({ ...prev, [taskId]: !prev[taskId] }));
  };

  const handleParentClick = (taskId: string) => {
    setSelectedTaskId(taskId);
    setViewMode('schedule');
  };

  const handleRunClick = (conversationId: string) => {
    if (conversations[conversationId]) {
      switchConversation(conversationId);
      setViewMode('chat');
    }
  };

  const handleRunContextMenu = (
    e: React.MouseEvent,
    taskId: string,
    run: ScheduledTaskRun
  ) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, taskId, run });
  };

  const handleArchiveRun = () => {
    if (!contextMenu) return;
    const { taskId, run } = contextMenu;
    // Delete the associated conversation if it exists
    if (conversations[run.conversationId]) {
      deleteConversation(run.conversationId);
    }
    // Remove the run from the schedule task
    removeRun(taskId, run.id);
    setContextMenu(null);
  };

  const handleViewScheduledTask = () => {
    if (!contextMenu) return;
    setSelectedTaskId(contextMenu.taskId);
    setViewMode('schedule');
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
        <span>{t.sidebar.scheduled}</span>
      </button>

      {sectionOpen && (
        <div className="space-y-0.5">
          {tasksWithRuns.map((task) => {
            const isExpanded = expandedTasks[task.id] ?? false;
            const visibleRuns = isExpanded
              ? task.runs.slice(0, MAX_VISIBLE_RUNS)
              : [];

            return (
              <div key={task.id}>
                {/* Parent task row — chevron toggles children, title opens detail */}
                <div className="flex items-center gap-1 px-2">
                  <button
                    onClick={() => toggleTask(task.id)}
                    className="shrink-0 p-1 text-[#656358] hover:text-[#29261b]"
                  >
                    <ChevronRight
                      className={cn('h-3 w-3 transition-transform', isExpanded && 'rotate-90')}
                    />
                  </button>
                  <button
                    onClick={() => handleParentClick(task.id)}
                    className={cn(
                      'flex-1 min-w-0 text-left py-1 rounded-md text-[12px] truncate',
                      'text-[#3d3929] hover:text-[#29261b]'
                    )}
                  >
                    <span className="truncate">{task.name}</span>
                  </button>
                </div>

                {/* Child run items */}
                {isExpanded && (
                  <div className="ml-5 space-y-px">
                    {visibleRuns.map((run) => {
                      const convExists = !!conversations[run.conversationId];
                      const isActive = run.conversationId === activeConversationId && viewMode === 'chat';
                      // Label: "M/D HH:mm - TaskName" like Cowork's "Mar 5 - Hello greeting"
                      const label = `${formatRunDate(run.startedAt)} - ${task.name}`;

                      return (
                        <button
                          key={run.id}
                          onClick={() => handleRunClick(run.conversationId)}
                          onContextMenu={(e) => handleRunContextMenu(e, task.id, run)}
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
                          <RunStatusDot status={run.status} startedAt={run.startedAt} />
                          <span className="truncate">{label}</span>
                        </button>
                      );
                    })}
                    {task.runs.length > MAX_VISIBLE_RUNS && (
                      <button
                        onClick={() => toggleTask(task.id)}
                        className="w-full px-2 py-0.5 text-[11px] text-[#999] hover:text-[#656358] text-left"
                      >
                        +{task.runs.length - MAX_VISIBLE_RUNS} more
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Context menu for child runs */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-50 bg-white rounded-lg shadow-lg border border-[#e8e4dd] py-1 min-w-[160px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            onClick={handleViewScheduledTask}
            className="flex items-center gap-2 w-full px-3 py-1.5 text-[13px] text-[#3d3929] hover:bg-[#f0ede6]"
          >
            <Clock className="h-3.5 w-3.5" />
            {t.sidebar.viewScheduledTask}
          </button>
          <button
            onClick={handleArchiveRun}
            className="flex items-center gap-2 w-full px-3 py-1.5 text-[13px] text-red-500 hover:bg-[#f0ede6]"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t.sidebar.archiveRun}
          </button>
        </div>
      )}
    </div>
  );
}
