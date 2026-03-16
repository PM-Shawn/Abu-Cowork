import { useState } from 'react';
import { useTriggerStore } from '@/stores/triggerStore';
import { triggerEngine } from '@/core/trigger/triggerEngine';
import { useI18n } from '@/i18n';
import {
  ArrowLeft,
  Pencil,
  Pause,
  Play,
  Trash2,
  Copy,
  Check,
  Zap,
} from 'lucide-react';
import { useToastStore } from '@/stores/toastStore';
import { useIMChannelStore } from '@/stores/imChannelStore';
import { cn } from '@/lib/utils';
import TriggerRunHistory from './TriggerRunHistory';
import ConfirmDialog from '@/components/common/ConfirmDialog';

export default function TriggerDetail() {
  const { t } = useI18n();
  const {
    triggers,
    selectedTriggerId,
    setSelectedTriggerId,
    setTriggerStatus,
    deleteTrigger,
    openEditor,
  } = useTriggerStore();

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [copied, setCopied] = useState(false);

  const trigger = selectedTriggerId ? triggers[selectedTriggerId] : null;

  if (!trigger) return null;

  const isPaused = trigger.status === 'paused';
  const serverPort = triggerEngine.getServerPort() ?? 18080;
  const endpoint = `http://localhost:${serverPort}/trigger/${trigger.id}`;
  const curlExample = `curl -X POST ${endpoint} \\\n  -H "Content-Type: application/json" \\\n  -d '{"data": {"content": "test message"}}'`;

  const handleCopyEndpoint = async () => {
    try {
      await navigator.clipboard.writeText(endpoint);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback
    }
  };

  const confirmDelete = () => {
    setShowDeleteConfirm(false);
    deleteTrigger(trigger.id);
  };

  const handleBack = () => {
    setSelectedTriggerId(null);
  };

  const handleTestTrigger = () => {
    let testPayload;
    if (trigger.source.type === 'file') {
      // Simulate a realistic file event payload
      testPayload = { data: {
        event: 'create',
        paths: [`${trigger.source.path}/test-file.txt`],
        watchPath: trigger.source.path,
        _test: true,
        timestamp: Date.now(),
      } };
    } else if (trigger.source.type === 'cron') {
      testPayload = { data: { event: 'cron', run: 1, _test: true, timestamp: Date.now() } };
    } else {
      testPayload = { data: { content: 'test message', _test: true, timestamp: Date.now() } };
    }
    triggerEngine.handleEvent(trigger.id, testPayload, { skipChecks: true });
    useToastStore.getState().addToast({ type: 'success', title: t.trigger.testTriggerSent });
  };

  // Filter description
  let filterDesc = t.trigger.filterAlways;
  if (trigger.filter.type === 'keyword') {
    filterDesc = `${t.trigger.filterKeyword}: ${(trigger.filter.keywords ?? []).join(', ')}`;
  } else if (trigger.filter.type === 'regex') {
    filterDesc = `${t.trigger.filterRegex}: ${trigger.filter.pattern}`;
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-4 border-b border-[#e8e4dd] bg-white">
        <button
          onClick={handleBack}
          className="p-1.5 rounded-md text-[#656358] hover:bg-[#f5f3ee] hover:text-[#29261b] transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <h1 className="text-[18px] font-semibold text-[#29261b] flex-1 truncate">
          {trigger.name}
        </h1>
        <button
          onClick={() => openEditor(trigger.id)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] text-[#3d3929] hover:bg-[#f5f3ee] transition-colors"
        >
          <Pencil className="h-3.5 w-3.5" />
          {t.trigger.edit}
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        <div className="px-6 py-5 space-y-5">
          {/* Info section */}
          <div className="bg-white rounded-xl border border-[#e8e4dd] p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-[13px] text-[#656358]">{t.trigger.status}</span>
              <span className="flex items-center gap-1.5">
                <span className={cn('w-2 h-2 rounded-full', isPaused ? 'bg-neutral-300' : 'bg-green-500')} />
                <span className={cn('text-[13px] font-medium', isPaused ? 'text-neutral-500' : 'text-green-600')}>
                  {isPaused ? t.trigger.statusPaused : t.trigger.statusActive}
                </span>
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[13px] text-[#656358]">{t.trigger.sourceType}</span>
              <span className="text-[13px] text-[#29261b]">
                {trigger.source.type === 'http' ? t.trigger.sourceHttp : trigger.source.type === 'file' ? t.trigger.sourceFile : trigger.source.type === 'im' ? t.trigger.imSource : t.trigger.sourceCron}
              </span>
            </div>
            {trigger.source.type === 'file' && (
              <div className="flex items-center justify-between">
                <span className="text-[13px] text-[#656358]">{t.trigger.filePath}</span>
                <span className="text-[13px] text-[#29261b] truncate max-w-[200px]" title={trigger.source.path}>{trigger.source.path}</span>
              </div>
            )}
            {trigger.source.type === 'cron' && (
              <div className="flex items-center justify-between">
                <span className="text-[13px] text-[#656358]">{t.trigger.cronInterval}</span>
                <span className="text-[13px] text-[#29261b]">{t.trigger.cronIntervalSeconds.replace('{n}', String(trigger.source.intervalSeconds))}</span>
              </div>
            )}
            {trigger.source.type === 'im' && (
              <IMSourceDetail channelId={trigger.source.channelId} />
            )}
            <div className="flex items-center justify-between">
              <span className="text-[13px] text-[#656358]">{t.trigger.filter}</span>
              <span className="text-[13px] text-[#29261b]">{filterDesc}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[13px] text-[#656358]">{t.trigger.debounce}</span>
              <span className="text-[13px] text-[#29261b]">
                {trigger.debounce.enabled ? t.trigger.debounceSeconds.replace('{n}', String(trigger.debounce.windowSeconds)) : t.trigger.debounceOff}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[13px] text-[#656358]">{t.trigger.quietHours}</span>
              <span className="text-[13px] text-[#29261b]">
                {trigger.quietHours?.enabled
                  ? `${trigger.quietHours.start} ~ ${trigger.quietHours.end}`
                  : t.trigger.debounceOff}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[13px] text-[#656358]">{t.trigger.totalRuns}</span>
              <span className="text-[13px] text-[#29261b]">{t.trigger.totalRunsCount.replace('{n}', String(trigger.totalRuns))}</span>
            </div>
          </div>

          {/* Statistics */}
          {trigger.runs.length > 0 && (() => {
            const completed = trigger.runs.filter((r) => r.status === 'completed').length;
            const errors = trigger.runs.filter((r) => r.status === 'error').length;
            const filtered = trigger.runs.filter((r) => r.status === 'filtered' || r.status === 'debounced').length;
            const total = completed + errors;
            const successRate = total > 0 ? Math.round((completed / total) * 100) : 0;
            return (
              <div className="grid grid-cols-4 gap-2">
                <div className="bg-white rounded-xl border border-[#e8e4dd] p-3 text-center">
                  <div className="text-[18px] font-semibold text-[#29261b]">{total > 0 ? `${successRate}%` : t.trigger.statsAvgNotAvailable}</div>
                  <div className="text-[11px] text-[#656358] mt-0.5">{t.trigger.statsSuccessRate}</div>
                </div>
                <div className="bg-white rounded-xl border border-[#e8e4dd] p-3 text-center">
                  <div className="text-[18px] font-semibold text-green-600">{completed}</div>
                  <div className="text-[11px] text-[#656358] mt-0.5">{t.trigger.statsCompleted}</div>
                </div>
                <div className="bg-white rounded-xl border border-[#e8e4dd] p-3 text-center">
                  <div className="text-[18px] font-semibold text-red-500">{errors}</div>
                  <div className="text-[11px] text-[#656358] mt-0.5">{t.trigger.statsErrors}</div>
                </div>
                <div className="bg-white rounded-xl border border-[#e8e4dd] p-3 text-center">
                  <div className="text-[18px] font-semibold text-neutral-400">{filtered}</div>
                  <div className="text-[11px] text-[#656358] mt-0.5">{t.trigger.statsFiltered}</div>
                </div>
              </div>
            );
          })()}

          {/* HTTP Endpoint — only for HTTP triggers */}
          {trigger.source.type === 'http' && <div className="bg-white rounded-xl border border-[#e8e4dd] p-4">
            <div className="text-[13px] text-[#656358] mb-2">{t.trigger.httpEndpoint}</div>
            <div className="flex items-center gap-2 mb-3">
              <code className="flex-1 text-[13px] text-[#29261b] bg-[#faf8f5] rounded-lg px-3 py-2 font-mono truncate">
                POST {endpoint}
              </code>
              <button
                onClick={handleCopyEndpoint}
                className="p-2 rounded-lg text-[#656358] hover:bg-[#f5f3ee] hover:text-[#29261b] transition-colors shrink-0"
                title={t.trigger.copyEndpoint}
              >
                {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
            </div>
            <div className="text-[12px] text-[#656358] mb-1">{t.trigger.curlExample}</div>
            <pre className="text-[12px] text-[#29261b] bg-[#faf8f5] rounded-lg p-3 font-mono whitespace-pre-wrap overflow-x-auto">
              {curlExample}
            </pre>
          </div>}

          {/* Description */}
          {trigger.description && (
            <div className="bg-white rounded-xl border border-[#e8e4dd] p-4">
              <div className="text-[13px] text-[#656358] mb-1.5">{t.trigger.description}</div>
              <p className="text-[14px] text-[#29261b] leading-relaxed whitespace-pre-wrap">
                {trigger.description}
              </p>
            </div>
          )}

          {/* Prompt */}
          <div className="bg-white rounded-xl border border-[#e8e4dd] p-4">
            <div className="text-[13px] text-[#656358] mb-1.5">{t.trigger.prompt}</div>
            <p className="text-[14px] text-[#29261b] leading-relaxed whitespace-pre-wrap font-mono bg-[#faf8f5] rounded-lg p-3 text-[13px]">
              {trigger.action.prompt}
            </p>
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => setTriggerStatus(trigger.id, isPaused ? 'active' : 'paused')}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13px] font-medium bg-[#f5f3ee] text-[#3d3929] hover:bg-[#e8e5de] transition-colors"
            >
              {isPaused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
              {isPaused ? t.trigger.resume : t.trigger.pause}
            </button>
            <button
              onClick={handleTestTrigger}
              disabled={isPaused}
              className={cn(
                'flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13px] font-medium transition-colors',
                isPaused
                  ? 'bg-[#f5f3ee] text-[#9a9689] cursor-not-allowed'
                  : 'bg-[#f5f3ee] text-[#3d3929] hover:bg-[#e8e5de]'
              )}
            >
              <Zap className="h-3.5 w-3.5" />
              {t.trigger.testTrigger}
            </button>

            <div className="flex-1" />

            <button
              onClick={() => setShowDeleteConfirm(true)}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13px] font-medium text-red-500 hover:bg-red-50 transition-colors"
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t.trigger.delete}
            </button>
          </div>

          {/* Run history */}
          <div className="bg-white rounded-xl border border-[#e8e4dd] overflow-hidden">
            <div className="px-4 py-3 border-b border-[#e8e4dd]">
              <h3 className="text-[14px] font-medium text-[#29261b]">
                {t.trigger.runHistory}
              </h3>
            </div>
            <TriggerRunHistory runs={trigger.runs} />
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={showDeleteConfirm}
        title={t.trigger.delete}
        message={t.trigger.deleteConfirm}
        confirmText={t.common.confirm}
        cancelText={t.common.cancel}
        onConfirm={confirmDelete}
        onCancel={() => setShowDeleteConfirm(false)}
        variant="danger"
      />
    </div>
  );
}

/** Show IM channel name in trigger detail */
function IMSourceDetail({ channelId }: { channelId: string }) {
  const channel = useIMChannelStore((s) => s.channels[channelId]);
  const { t } = useI18n();
  return (
    <div className="flex items-center justify-between">
      <span className="text-[13px] text-[#656358]">{t.trigger.imSelectChannel}</span>
      <span className="text-[13px] text-[#29261b]">
        {channel ? `${channel.name} (${channel.platform})` : channelId}
      </span>
    </div>
  );
}
