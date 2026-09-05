import { useState } from 'react';
import { useScheduleStore } from '@/stores/scheduleStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { summarizeBrowserAuthorization } from '@/core/permissions/browserAuthorizationSummary';
import { useI18n, format } from '@/i18n';
import { schedulerEngine } from '@/core/scheduler/scheduler';
import {
  ArrowLeft,
  Pencil,
  Play,
  Pause,
  Trash2,
  RotateCw,
  Clock,
  ShieldCheck,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ScheduleFrequency } from '@/types/schedule';
import ScheduleRunHistory from './ScheduleRunHistory';
import ConfirmDialog from '@/components/common/ConfirmDialog';

/** Keep the chip row one or two lines; the rest is a "+N more" trailer. */
const MAX_LISTED_AUTH_ORIGINS = 6;

function getFrequencyLabel(
  freq: ScheduleFrequency,
  t: ReturnType<typeof useI18n>['t']
): string {
  const map: Record<ScheduleFrequency, string> = {
    hourly: t.schedule.frequencyHourly,
    daily: t.schedule.frequencyDaily,
    weekly: t.schedule.frequencyWeekly,
    weekdays: t.schedule.frequencyWeekdays,
    manual: t.schedule.frequencyManual,
  };
  return map[freq];
}

export default function ScheduleTaskDetail() {
  const { t } = useI18n();
  const {
    tasks,
    selectedTaskId,
    setSelectedTaskId,
    pauseTask,
    resumeTask,
    deleteTask,
    openEditor,
  } = useScheduleStore();

  const sitePermissions = useSettingsStore((s) => s.browserSitePermissions);
  const allowUnattendedBrowser = useSettingsStore((s) => s.allowUnattendedBrowser);
  const openSystemSettings = useSettingsStore((s) => s.openSystemSettings);
  const browserAuth = summarizeBrowserAuthorization(sitePermissions, allowUnattendedBrowser);

  const [isRunning, setIsRunning] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const task = selectedTaskId ? tasks[selectedTaskId] : null;

  if (!task) return null;

  const isPaused = task.status === 'paused';

  const handleRunNow = async () => {
    setIsRunning(true);
    try {
      await schedulerEngine.runNow(task.id);
    } finally {
      setIsRunning(false);
    }
  };

  const handleDelete = () => {
    setShowDeleteConfirm(true);
  };

  const confirmDelete = () => {
    setShowDeleteConfirm(false);
    deleteTask(task.id);
  };

  const handleEdit = () => {
    openEditor(task.id);
  };

  const handleBack = () => {
    setSelectedTaskId(null);
  };

  // Build schedule description
  const freq = getFrequencyLabel(task.schedule.frequency, t);
  const time = task.schedule.time;
  let scheduleDesc = freq;
  if (time) {
    if (task.schedule.frequency === 'hourly') {
      scheduleDesc = `${freq} :${time.minute.toString().padStart(2, '0')}`;
    } else {
      const timeStr = `${time.hour.toString().padStart(2, '0')}:${time.minute.toString().padStart(2, '0')}`;
      if (task.schedule.frequency === 'weekly') {
        const days = [
          t.schedule.sunday, t.schedule.monday, t.schedule.tuesday,
          t.schedule.wednesday, t.schedule.thursday, t.schedule.friday,
          t.schedule.saturday,
        ];
        const day = days[task.schedule.dayOfWeek ?? 1];
        scheduleDesc = `${freq} ${day} ${timeStr}`;
      } else {
        scheduleDesc = `${freq} ${timeStr}`;
      }
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-4 border-b border-[var(--abu-border)] bg-[var(--abu-bg-base)]">
        <button
          onClick={handleBack}
          className="p-1.5 rounded-md text-[var(--abu-text-tertiary)] hover:bg-[var(--abu-bg-muted)] hover:text-[var(--abu-text-primary)] transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <h1 className="text-h-md font-semibold text-[var(--abu-text-primary)] flex-1 truncate">
          {task.name}
        </h1>
        <button
          onClick={handleEdit}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-body text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-muted)] transition-colors"
        >
          <Pencil className="h-3.5 w-3.5" />
          {t.schedule.edit}
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        <div className="px-6 py-5 space-y-5">
          {/* Info section */}
          <div className="bg-[var(--abu-bg-muted)] rounded-xl border border-[var(--abu-border)] p-4 space-y-3">
            {/* Status */}
            <div className="flex items-center justify-between">
              <span className="text-body text-[var(--abu-text-tertiary)]">{t.schedule.status}</span>
              <span className="flex items-center gap-1.5">
                <span
                  className={cn(
                    'w-2 h-2 rounded-full',
                    isPaused ? 'bg-neutral-300' : 'bg-[var(--abu-success-solid)]'
                  )}
                />
                <span className={cn(
                  'text-body font-medium',
                  isPaused ? 'text-[var(--abu-text-tertiary)]' : 'text-[var(--abu-success)]'
                )}>
                  {isPaused ? t.schedule.statusPaused : t.schedule.statusActive}
                </span>
              </span>
            </div>

            {/* Schedule */}
            <div className="flex items-center justify-between">
              <span className="text-body text-[var(--abu-text-tertiary)]">{t.schedule.schedule}</span>
              <span className="flex items-center gap-1.5 text-body text-[var(--abu-text-primary)]">
                <Clock className="h-3.5 w-3.5 text-[var(--abu-text-tertiary)]" />
                {scheduleDesc}
              </span>
            </div>

            {/* Total runs */}
            <div className="flex items-center justify-between">
              <span className="text-body text-[var(--abu-text-tertiary)]">{t.schedule.runHistory}</span>
              <span className="text-body text-[var(--abu-text-primary)]">
                {format(t.schedule.totalRuns, { count: task.totalRuns })}
              </span>
            </div>
          </div>

          {/* Browser authorization (U5 authorization visibility).
              A scheduled task runs unattended, so the browser gate lets it act
              only on the sites the user granted — a standing authorization
              that was, until now, visible nowhere near the task acting under
              it. Shown here with the entry point to change it; the verdicts
              themselves stay owned by Settings (one place to revoke, not two
              that can disagree). */}
          <div className="bg-[var(--abu-bg-muted)] rounded-xl border border-[var(--abu-border)] p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-body text-[var(--abu-text-tertiary)]">
                  {t.schedule.browserAuthTitle}
                </div>
                <p className="mt-1 text-minor leading-relaxed text-[var(--abu-text-muted)]">
                  {browserAuth.masterSwitchOn
                    ? t.schedule.browserAuthDesc
                    : t.schedule.browserAuthOff}
                </p>
              </div>
              <button
                onClick={() => openSystemSettings('capabilities')}
                className="shrink-0 flex items-center gap-1 rounded-lg border border-[var(--abu-border)] bg-[var(--abu-bg-base)] px-2.5 py-1 text-minor font-medium text-[var(--abu-text-secondary)] transition-colors hover:bg-[var(--abu-bg-hover)]"
              >
                <ShieldCheck className="h-3.5 w-3.5" />
                {t.schedule.browserAuthManage}
              </button>
            </div>
            {browserAuth.masterSwitchOn && (
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {browserAuth.reachableUnattended.length === 0 ? (
                  <span className="text-minor text-[var(--abu-text-tertiary)]">
                    {t.schedule.browserAuthNone}
                  </span>
                ) : (
                  <>
                    {browserAuth.reachableUnattended.slice(0, MAX_LISTED_AUTH_ORIGINS).map((origin) => (
                      <span
                        key={origin}
                        title={origin}
                        className="max-w-full truncate rounded-md bg-[var(--abu-success-bg)] px-1.5 py-0.5 text-caption text-[var(--abu-success)]"
                      >
                        {origin}
                      </span>
                    ))}
                    {browserAuth.reachableUnattended.length > MAX_LISTED_AUTH_ORIGINS && (
                      <span className="rounded-md px-1.5 py-0.5 text-caption text-[var(--abu-text-tertiary)]">
                        {format(t.schedule.browserAuthMore, {
                          count: browserAuth.reachableUnattended.length - MAX_LISTED_AUTH_ORIGINS,
                        })}
                      </span>
                    )}
                  </>
                )}
              </div>
            )}
          </div>

          {/* Description */}
          {task.description && (
            <div className="bg-[var(--abu-bg-muted)] rounded-xl border border-[var(--abu-border)] p-4">
              <div className="text-body text-[var(--abu-text-tertiary)] mb-1.5">{t.schedule.description}</div>
              <p className="text-body text-[var(--abu-text-primary)] leading-relaxed whitespace-pre-wrap">
                {task.description}
              </p>
            </div>
          )}

          {/* Prompt */}
          <div className="bg-[var(--abu-bg-muted)] rounded-xl border border-[var(--abu-border)] p-4">
            <div className="text-body text-[var(--abu-text-tertiary)] mb-1.5">{t.schedule.prompt}</div>
            <p className="text-[var(--abu-text-primary)] leading-relaxed whitespace-pre-wrap font-mono bg-[var(--abu-bg-base)] rounded-lg p-3 text-body">
              {task.prompt}
            </p>
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-2">
            <button
              onClick={handleRunNow}
              disabled={isRunning}
              className={cn(
                'flex items-center gap-1.5 px-4 py-2 rounded-lg text-body font-medium transition-colors',
                isRunning
                  ? 'bg-[var(--abu-warning-bg)] text-[var(--abu-warning)] cursor-not-allowed'
                  : 'bg-[var(--abu-clay)] text-white hover:bg-[var(--abu-clay-hover)]'
              )}
            >
              {isRunning ? (
                <RotateCw className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
              {isRunning ? t.schedule.running : t.schedule.runNow}
            </button>

            <button
              onClick={() => isPaused ? resumeTask(task.id) : pauseTask(task.id)}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-body font-medium bg-[var(--abu-bg-muted)] text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-hover)] transition-colors"
            >
              {isPaused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
              {isPaused ? t.schedule.resume : t.schedule.pause}
            </button>

            <div className="flex-1" />

            <button
              onClick={handleDelete}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-body font-medium text-[var(--abu-danger)] hover:bg-[var(--abu-danger-bg)] transition-colors"
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t.schedule.delete}
            </button>
          </div>

          {/* Run history */}
          <div className="bg-[var(--abu-bg-muted)] rounded-xl border border-[var(--abu-border)] overflow-hidden">
            <div className="px-4 py-3 border-b border-[var(--abu-border)]">
              <h3 className="text-h-sm font-medium text-[var(--abu-text-primary)]">
                {t.schedule.runHistory}
              </h3>
            </div>
            <ScheduleRunHistory runs={task.runs} />
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={showDeleteConfirm}
        title={t.schedule.delete}
        message={t.schedule.deleteConfirm}
        confirmText={t.common.confirm}
        cancelText={t.common.cancel}
        onConfirm={confirmDelete}
        onCancel={() => setShowDeleteConfirm(false)}
        variant="danger"
      />
    </div>
  );
}
