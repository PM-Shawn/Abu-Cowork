import { useState } from 'react';
import { Button, IconButton } from '@/components/ds/button';
import { useConfirm } from '@/components/ds/confirm-context';
import { AppIcons } from '@/components/ds/icons';
import { ScrollArea } from '@/components/ds/scroll-area';
import { StatusIcon } from '@/components/ds/status-icon';
import { Tag } from '@/components/ds/tag';
import { triggerEngine } from '@/core/trigger/triggerEngine';
import { normalizeTriggerCapability } from '@/core/trigger/triggerCapability';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useIMChannelStore } from '@/stores/imChannelStore';
import { useToastStore } from '@/stores/toastStore';
import { useTriggerStore } from '@/stores/triggerStore';
import type { TriggerCapability } from '@/types/trigger';
import TriggerRunHistory from './TriggerRunHistory';

// A flat box for one group of facts about the listener.
const SECTION = 'rounded-panel border border-separator p-4';
const SECTION_TITLE = 'text-ui-sm text-label-tertiary';
// One fact: its label and its value share this row, label left and value right.
const FACT = 'flex items-center justify-between gap-3';
const FACT_VALUE = 'text-ui text-label';
// One count of the run statistics.
const STAT = 'rounded-panel border border-separator p-3 text-center';
const STAT_NUMBER = 'text-title text-label';
const STAT_LABEL = 'mt-1 flex items-center justify-center gap-1 text-caption text-label-tertiary';

export default function TriggerDetail({ onQuestionClosed }: {
  // Called once the delete question has gone, whatever the answer: the page may have left under it.
  onQuestionClosed?: () => void;
}) {
  const { t } = useI18n();
  const confirm = useConfirm();
  const {
    triggers,
    selectedTriggerId,
    setSelectedTriggerId,
    setTriggerStatus,
    openEditor,
  } = useTriggerStore();

  const [copied, setCopied] = useState(false);

  const trigger = selectedTriggerId ? triggers[selectedTriggerId] : null;

  if (!trigger) return null;

  const isPaused = trigger.status === 'paused';
  const effectiveCapability = normalizeTriggerCapability(trigger.action.capability);
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

  // Deleting cannot be taken back, so it is asked first, naming the listener. The answer acts on
  // the store as it is at that moment: nothing is deleted once the listener has left it.
  const handleDelete = async () => {
    const id = trigger.id;
    const confirmed = await confirm({
      title: t.trigger.delete,
      message: `${t.trigger.deleteConfirm}\n${trigger.name}`,
      confirmLabel: t.common.confirm,
      tone: 'danger',
    });
    const store = useTriggerStore.getState();
    if (confirmed && store.triggers[id]) store.deleteTrigger(id);
    onQuestionClosed?.();
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

  const capabilityLabels: Record<TriggerCapability, string> = {
    read_tools: t.trigger.capabilityReadTools,
    safe_tools: t.trigger.capabilitySafeTools,
    full: t.trigger.capabilityFull,
    custom: t.trigger.capabilityCustomLegacy,
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header: the way back, the listener's name, edit. */}
      <div className="flex items-center gap-3 border-b border-separator px-6 py-4">
        <IconButton icon={AppIcons.back} label={t.schedule.backToList} data-automation-back onClick={handleBack} />
        <h1 className="min-w-0 flex-1 truncate text-title text-label">
          {trigger.name}
        </h1>
        <Button variant="secondary" size="sm" icon={AppIcons.rename} onClick={() => openEditor(trigger.id)}>
          {t.trigger.edit}
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-5 px-6 py-5">
          <div data-trigger-section className={cn(SECTION, 'space-y-3')}>
            <div className={FACT}>
              <span className={SECTION_TITLE}>{t.trigger.status}</span>
              {isPaused
                ? <Tag>{t.trigger.statusPaused}</Tag>
                : <Tag tone="success">{t.trigger.statusActive}</Tag>}
            </div>
            <div className={FACT}>
              <span className={SECTION_TITLE}>{t.trigger.sourceType}</span>
              <span className={FACT_VALUE}>
                {trigger.source.type === 'http' ? t.trigger.sourceHttp : trigger.source.type === 'file' ? t.trigger.sourceFile : trigger.source.type === 'im' ? t.trigger.imSource : t.trigger.sourceCron}
              </span>
            </div>
            {trigger.source.type === 'file' && (
              <div className={FACT}>
                <span className={SECTION_TITLE}>{t.trigger.filePath}</span>
                <span className={cn(FACT_VALUE, 'max-w-50 truncate')} title={trigger.source.path}>{trigger.source.path}</span>
              </div>
            )}
            {trigger.source.type === 'cron' && (
              <div className={FACT}>
                <span className={SECTION_TITLE}>{t.trigger.cronInterval}</span>
                <span className={FACT_VALUE}>{t.trigger.cronIntervalSeconds.replace('{n}', String(trigger.source.intervalSeconds))}</span>
              </div>
            )}
            {trigger.source.type === 'im' && (
              <IMSourceDetail channelId={trigger.source.channelId} />
            )}
            <div className={FACT}>
              <span className={SECTION_TITLE}>{t.trigger.filter}</span>
              <span className={FACT_VALUE}>{filterDesc}</span>
            </div>
            <div className={FACT}>
              <span className={SECTION_TITLE}>{t.trigger.capability}</span>
              <span className={FACT_VALUE}>{capabilityLabels[effectiveCapability]}</span>
            </div>
            <div className={FACT}>
              <span className={SECTION_TITLE}>{t.trigger.debounce}</span>
              <span className={FACT_VALUE}>
                {trigger.debounce.enabled ? t.trigger.debounceSeconds.replace('{n}', String(trigger.debounce.windowSeconds)) : t.trigger.debounceOff}
              </span>
            </div>
            <div className={FACT}>
              <span className={SECTION_TITLE}>{t.trigger.quietHours}</span>
              <span className={FACT_VALUE}>
                {trigger.quietHours?.enabled
                  ? `${trigger.quietHours.start} ~ ${trigger.quietHours.end}`
                  : t.trigger.debounceOff}
              </span>
            </div>
            <div className={FACT}>
              <span className={SECTION_TITLE}>{t.trigger.totalRuns}</span>
              <span className={FACT_VALUE}>{t.trigger.totalRunsCount.replace('{n}', String(trigger.totalRuns))}</span>
            </div>
          </div>

          {/* How the recent runs ended. The numbers are plain; worked and failed carry their shape. */}
          {trigger.runs.length > 0 && (() => {
            const completed = trigger.runs.filter((r) => r.status === 'completed').length;
            const errors = trigger.runs.filter((r) => r.status === 'error').length;
            const filtered = trigger.runs.filter((r) => r.status === 'filtered' || r.status === 'debounced').length;
            const total = completed + errors;
            const successRate = total > 0 ? Math.round((completed / total) * 100) : 0;
            return (
              <div className="grid grid-cols-4 gap-2">
                <div data-trigger-stat className={STAT}>
                  <div className={STAT_NUMBER}>{total > 0 ? `${successRate}%` : t.trigger.statsAvgNotAvailable}</div>
                  <div className={STAT_LABEL}>{t.trigger.statsSuccessRate}</div>
                </div>
                <div data-trigger-stat className={STAT}>
                  <div className={STAT_NUMBER}>{completed}</div>
                  <div className={STAT_LABEL}><StatusIcon tone="success" size="sm" />{t.trigger.statsCompleted}</div>
                </div>
                <div data-trigger-stat className={STAT}>
                  <div className={STAT_NUMBER}>{errors}</div>
                  <div className={STAT_LABEL}><StatusIcon tone="danger" size="sm" />{t.trigger.statsErrors}</div>
                </div>
                <div data-trigger-stat className={STAT}>
                  <div className={STAT_NUMBER}>{filtered}</div>
                  <div className={STAT_LABEL}>{t.trigger.statsFiltered}</div>
                </div>
              </div>
            );
          })()}

          {/* Where an HTTP listener receives its events. The address is shown as text here and
              goes to the clipboard on request; it is in no attribute of any element. */}
          {trigger.source.type === 'http' && (
            <div data-trigger-section className={SECTION}>
              <div className={cn(SECTION_TITLE, 'mb-2')}>{t.trigger.httpEndpoint}</div>
              <div className="mb-3 flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-control bg-code px-3 py-2 font-code text-ui-sm text-label">
                  POST {endpoint}
                </code>
                <span className="flex shrink-0">
                  <IconButton
                    size="sm"
                    icon={copied ? AppIcons.done : AppIcons.copy}
                    label={t.trigger.copyEndpoint}
                    onClick={() => { void handleCopyEndpoint(); }}
                  />
                </span>
              </div>
              <div className={cn(SECTION_TITLE, 'mb-1')}>{t.trigger.curlExample}</div>
              <pre className="rounded-control bg-code p-3 font-code text-ui-sm text-label whitespace-pre-wrap break-all">
                {curlExample}
              </pre>
            </div>
          )}

          {trigger.description && (
            <div data-trigger-section className={SECTION}>
              <div className={cn(SECTION_TITLE, 'mb-2')}>{t.trigger.description}</div>
              <p className="whitespace-pre-wrap text-ui text-label">
                {trigger.description}
              </p>
            </div>
          )}

          <div data-trigger-section className={SECTION}>
            <div className={cn(SECTION_TITLE, 'mb-2')}>{t.trigger.prompt}</div>
            <p className="rounded-control bg-code p-3 font-code text-ui-sm text-label whitespace-pre-wrap break-words">
              {trigger.action.prompt}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              icon={isPaused ? AppIcons.continue : AppIcons.pause}
              onClick={() => setTriggerStatus(trigger.id, isPaused ? 'active' : 'paused')}
            >
              {isPaused ? t.trigger.resume : t.trigger.pause}
            </Button>
            {/* A paused listener takes no event, a test one included. */}
            <Button variant="secondary" icon={AppIcons.trigger} disabled={isPaused} onClick={handleTestTrigger}>
              {t.trigger.testTrigger}
            </Button>

            <div className="flex-1" />

            <Button variant="danger" icon={AppIcons.delete} onClick={() => { void handleDelete(); }}>
              {t.trigger.delete}
            </Button>
          </div>

          <div data-trigger-section className="overflow-hidden rounded-panel border border-separator">
            <div className="border-b border-separator px-4 py-3">
              <h3 className="text-ui font-medium text-label">
                {t.trigger.runHistory}
              </h3>
            </div>
            <TriggerRunHistory runs={trigger.runs} />
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}

/** Show IM channel name in trigger detail */
function IMSourceDetail({ channelId }: { channelId: string }) {
  const channel = useIMChannelStore((s) => s.channels[channelId]);
  const { t } = useI18n();
  return (
    <div className={FACT}>
      <span className={SECTION_TITLE}>{t.trigger.imSelectChannel}</span>
      <span className={FACT_VALUE}>
        {channel ? `${channel.name} (${channel.platform})` : channelId}
      </span>
    </div>
  );
}
