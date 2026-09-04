import { useState, useEffect, useMemo } from 'react';
import { useTriggerStore } from '@/stores/triggerStore';
import { useIMChannelStore } from '@/stores/imChannelStore';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { useProjectStore } from '@/stores/projectStore';
import { useI18n } from '@/i18n';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Select } from '@/components/ui/select';
import { outputSender } from '@/core/im/outputSender';
import { getOutputPlatformOptions } from '@/core/im/platformLabels';
import type { TriggerCapability, TriggerFilterType, TriggerSourceType, OutputPlatform, OutputExtractMode } from '@/types/trigger';
import type { IMListenScope } from '@/types/trigger';
import { triggerEngine } from '@/core/trigger/triggerEngine';
import { normalizeTriggerCapability } from '@/core/trigger/triggerCapability';

const SOURCE_TYPES: TriggerSourceType[] = ['http', 'file', 'cron', 'im'];
const FILTER_TYPES: TriggerFilterType[] = ['always', 'keyword', 'regex'];
const STANDARD_CAPABILITIES: Exclude<TriggerCapability, 'custom'>[] = ['read_tools', 'safe_tools', 'full'];

export default function TriggerEditor() {
  const { t } = useI18n();
  const { showEditor, editingTriggerId, editorTemplateDefaults, closeEditor, createTrigger, updateTrigger, triggers, setSelectedTriggerId } =
    useTriggerStore();
  const skills = useDiscoveryStore((s) => s.skills);
  const channelsMap = useIMChannelStore((s) => s.channels);
  const imChannels = useMemo(() => Object.values(channelsMap), [channelsMap]);
  const projectsMap = useProjectStore((s) => s.projects);
  const activeProjects = useMemo(() =>
    Object.values(projectsMap).filter((p) => !p.archived).sort((a, b) => b.lastActiveAt - a.lastActiveAt),
    [projectsMap]
  );

  const editingTrigger = editingTriggerId ? triggers[editingTriggerId] : null;
  const editingCapability = normalizeTriggerCapability(editingTrigger?.action.capability);

  // Form state
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [prompt, setPrompt] = useState('');
  const [filterType, setFilterType] = useState<TriggerFilterType>('always');
  const [keywords, setKeywords] = useState('');
  const [regexPattern, setRegexPattern] = useState('');
  const [filterField, setFilterField] = useState('');
  const [skillName, setSkillName] = useState('');
  const [workspacePath, setWorkspacePath] = useState('');
  const [projectId, setProjectId] = useState('');
  const [sourceType, setSourceType] = useState<TriggerSourceType>('http');
  const [fileWatchPath, setFileWatchPath] = useState('');
  const [fileEvents, setFileEvents] = useState<string[]>(['create', 'modify']);
  const [filePattern, setFilePattern] = useState('');
  const [cronInterval, setCronInterval] = useState(60);
  const [debounceEnabled, setDebounceEnabled] = useState(true);
  const [debounceSeconds, setDebounceSeconds] = useState(300);
  const [quietHoursEnabled, setQuietHoursEnabled] = useState(false);
  const [quietHoursStart, setQuietHoursStart] = useState('22:00');
  const [quietHoursEnd, setQuietHoursEnd] = useState('08:00');
  const [capability, setCapability] = useState<TriggerCapability>('read_tools');

  // IM source state — now references a channel
  const [imChannelId, setImChannelId] = useState('');
  const [imListenScope, setImListenScope] = useState<IMListenScope>('mention_only');
  const [imChatId, setImChatId] = useState('');
  const [imSenderMatch, setImSenderMatch] = useState('');

  // Output config state
  const [outputEnabled, setOutputEnabled] = useState(false);
  const [outputTarget, setOutputTarget] = useState<'webhook' | 'im_channel'>('webhook');
  const [outputPlatform, setOutputPlatform] = useState<OutputPlatform>('feishu');
  const [outputWebhookUrl, setOutputWebhookUrl] = useState('');
  const [outputChannelId, setOutputChannelId] = useState('');
  const [outputChatIds, setOutputChatIds] = useState('');
  const [outputUserIds, setOutputUserIds] = useState('');
  const [outputExtractMode, setOutputExtractMode] = useState<OutputExtractMode>('last_message');
  const [outputCustomTemplate, setOutputCustomTemplate] = useState('');
  const [outputCustomHeaders, setOutputCustomHeaders] = useState('');
  const [testPushStatus, setTestPushStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testPushError, setTestPushError] = useState('');

  // Derive the selected IM channel's platform for webhook URL display
  const selectedIMChannel = imChannels.find((c) => c.id === imChannelId);

  // Initialize form when editing
  useEffect(() => {
    const triggerToEdit = editingTriggerId
      ? useTriggerStore.getState().triggers[editingTriggerId]
      : null;
    if (triggerToEdit) {
      setName(triggerToEdit.name);
      setDescription(triggerToEdit.description ?? '');
      setPrompt(triggerToEdit.action.prompt);
      setSourceType(triggerToEdit.source.type);
      if (triggerToEdit.source.type === 'file') {
        setFileWatchPath(triggerToEdit.source.path);
        setFileEvents(triggerToEdit.source.events);
        setFilePattern(triggerToEdit.source.pattern ?? '');
      }
      if (triggerToEdit.source.type === 'cron') {
        setCronInterval(triggerToEdit.source.intervalSeconds);
      }
      if (triggerToEdit.source.type === 'im') {
        setImChannelId(triggerToEdit.source.channelId);
        setImListenScope(triggerToEdit.source.listenScope);
        setImChatId(triggerToEdit.source.chatId ?? '');
        setImSenderMatch(triggerToEdit.source.senderMatch ?? '');
      }
      setFilterType(triggerToEdit.filter.type);
      setKeywords((triggerToEdit.filter.keywords ?? []).join(', '));
      setRegexPattern(triggerToEdit.filter.pattern ?? '');
      setFilterField(triggerToEdit.filter.field ?? '');
      setSkillName(triggerToEdit.action.skillName ?? '');
      setWorkspacePath(triggerToEdit.action.workspacePath ?? '');
      setProjectId(triggerToEdit.projectId ?? '');
      setDebounceEnabled(triggerToEdit.debounce.enabled);
      setDebounceSeconds(triggerToEdit.debounce.windowSeconds);
      setQuietHoursEnabled(triggerToEdit.quietHours?.enabled ?? false);
      setQuietHoursStart(triggerToEdit.quietHours?.start ?? '22:00');
      setQuietHoursEnd(triggerToEdit.quietHours?.end ?? '08:00');
      setCapability(normalizeTriggerCapability(triggerToEdit.action.capability));
      setOutputEnabled(triggerToEdit.output?.enabled ?? false);
      setOutputTarget(triggerToEdit.output?.target ?? 'webhook');
      setOutputPlatform(triggerToEdit.output?.platform ?? 'dchat');
      setOutputWebhookUrl(triggerToEdit.output?.webhookUrl ?? '');
      setOutputChannelId(triggerToEdit.output?.outputChannelId ?? '');
      setOutputChatIds(triggerToEdit.output?.outputChatIds ?? '');
      setOutputUserIds(triggerToEdit.output?.outputUserIds ?? '');
      setOutputExtractMode(triggerToEdit.output?.extractMode ?? 'last_message');
      setOutputCustomTemplate(triggerToEdit.output?.customTemplate ?? '');
      setOutputCustomHeaders(
        triggerToEdit.output?.customHeaders
          ? Object.entries(triggerToEdit.output.customHeaders).map(([k, v]) => `${k}: ${v}`).join('\n')
          : ''
      );
    } else {
      // Apply template defaults if provided, otherwise reset to blank
      const tpl = editorTemplateDefaults;
      setName(tpl?.name ?? '');
      setDescription('');
      setPrompt(tpl?.prompt ?? '');
      setSourceType(tpl?.sourceType ?? 'http');
      setFileWatchPath('');
      setFileEvents(['create', 'modify']);
      setFilePattern('');
      setCronInterval(60);
      setImChannelId('');
      setImListenScope('mention_only');
      setImChatId('');
      setImSenderMatch('');
      setFilterType(tpl?.filterType ?? 'always');
      setKeywords(tpl?.keywords ?? '');
      setRegexPattern('');
      setFilterField('');
      setSkillName('');
      setWorkspacePath('');
      setProjectId('');
      setDebounceEnabled(true);
      setDebounceSeconds(300);
      setQuietHoursEnabled(false);
      setQuietHoursStart('22:00');
      setQuietHoursEnd('08:00');
      setCapability('read_tools');
      setOutputEnabled(false);
      setOutputTarget('webhook');
      setOutputPlatform('dchat');
      setOutputWebhookUrl('');
      setOutputChannelId('');
      setOutputChatIds('');
      setOutputUserIds('');
      setOutputExtractMode('last_message');
      setOutputCustomTemplate('');
      setOutputCustomHeaders('');
    }
    setTestPushStatus('idle');
    setTestPushError('');
  }, [editingTriggerId, showEditor, editorTemplateDefaults]);

  // Close on Escape
  useEffect(() => {
    if (!showEditor) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeEditor();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showEditor, closeEditor]);

  if (!showEditor) return null;

  // P0-3: Duplicate name check
  const isDuplicateName = name.trim() && Object.values(triggers).some(
    (t) => t.name === name.trim() && t.id !== editingTriggerId
  );

  const filterLabels: Record<TriggerFilterType, string> = {
    always: t.trigger.filterAlways,
    keyword: t.trigger.filterKeyword,
    regex: t.trigger.filterRegex,
  };
  const capabilityLabels: Record<TriggerCapability, string> = {
    read_tools: t.trigger.capabilityReadTools,
    safe_tools: t.trigger.capabilitySafeTools,
    full: t.trigger.capabilityFull,
    custom: t.trigger.capabilityCustomLegacy,
  };
  const capabilityDescriptions: Record<TriggerCapability, string> = {
    read_tools: t.trigger.capabilityReadToolsDescription,
    safe_tools: t.trigger.capabilitySafeToolsDescription,
    full: t.trigger.capabilityFullDescription,
    custom: t.trigger.capabilityCustomLegacyDescription,
  };
  const capabilityOptions = [
    ...STANDARD_CAPABILITIES.map((cap) => ({ value: cap, label: capabilityLabels[cap] })),
    ...(editingCapability === 'custom'
      ? [{ value: 'custom', label: t.trigger.capabilityCustomLegacy }]
      : []),
  ];

  // Channel options for Select
  const channelOptions = imChannels.map((c) => ({
    value: c.id,
    label: `${c.name} (${c.platform})`,
  }));

  const handleSave = () => {
    if (!name.trim() || !prompt.trim()) return;
    if (sourceType === 'file' && !fileWatchPath.trim()) return;
    if (sourceType === 'im' && !imChannelId) return;
    if (isDuplicateName) return;

    const keywordList = keywords
      .split(/[,，]/)
      .map((k) => k.trim())
      .filter(Boolean);

    const filter = {
      type: filterType,
      keywords: filterType === 'keyword' ? keywordList : undefined,
      pattern: filterType === 'regex' ? regexPattern : undefined,
      field: filterField || undefined,
    };

    // Resolve effective workspace: project's path takes priority
    const effectiveWorkspace = projectId
      ? useProjectStore.getState().projects[projectId]?.workspacePath || workspacePath
      : workspacePath;

    const action = {
      prompt: prompt.trim(),
      skillName: skillName || undefined,
      workspacePath: effectiveWorkspace || undefined,
      capability,
      permissions: capability === 'custom' ? editingTrigger?.action.permissions : undefined,
    };

    const debounce = {
      enabled: debounceEnabled,
      windowSeconds: debounceSeconds,
    };

    const quietHours = quietHoursEnabled
      ? { enabled: true, start: quietHoursStart, end: quietHoursEnd }
      : undefined;

    // Parse custom headers from textarea (one per line: "Key: Value")
    const parsedHeaders: Record<string, string> = {};
    if (outputCustomHeaders.trim()) {
      for (const line of outputCustomHeaders.split('\n')) {
        const idx = line.indexOf(':');
        if (idx > 0) {
          parsedHeaders[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
        }
      }
    }

    const output = outputEnabled
      ? {
          enabled: true as const,
          target: outputTarget,
          platform: outputTarget === 'webhook' ? outputPlatform : undefined,
          webhookUrl: outputTarget === 'webhook' ? outputWebhookUrl : undefined,
          outputChannelId: outputTarget === 'im_channel' ? outputChannelId : undefined,
          outputChatIds: outputTarget === 'im_channel' && outputChatIds.trim() ? outputChatIds.trim() : undefined,
          outputUserIds: outputTarget === 'im_channel' && outputUserIds.trim() ? outputUserIds.trim() : undefined,
          extractMode: outputExtractMode,
          customTemplate: outputExtractMode === 'custom_template' ? outputCustomTemplate : undefined,
          customHeaders: outputTarget === 'webhook' && Object.keys(parsedHeaders).length > 0 ? parsedHeaders : undefined,
        }
      : undefined;

    const source =
      sourceType === 'file'
        ? { type: 'file' as const, path: fileWatchPath, events: fileEvents as ('create' | 'modify' | 'delete')[], pattern: filePattern || undefined }
        : sourceType === 'cron'
          ? { type: 'cron' as const, intervalSeconds: Math.max(10, cronInterval) }
          : sourceType === 'im'
            ? {
                type: 'im' as const,
                channelId: imChannelId,
                listenScope: imListenScope,
                chatId: imChatId || undefined,
                senderMatch: imSenderMatch || undefined,
              }
            : { type: 'http' as const };

    if (editingTriggerId) {
      updateTrigger(editingTriggerId, {
        name: name.trim(),
        description: description.trim() || undefined,
        source,
        filter,
        action,
        debounce,
        quietHours,
        output,
        projectId: projectId || undefined,
      });
    } else {
      const newId = createTrigger({
        name: name.trim(),
        description: description.trim() || undefined,
        source,
        filter,
        action,
        debounce,
        quietHours,
        output,
        projectId: projectId || undefined,
      });
      // Auto-select new trigger to show detail view (with HTTP endpoint)
      setSelectedTriggerId(newId);
    }

    closeEditor();
  };

  return (
    <div data-electron-no-drag className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onMouseDown={(e) => { if (e.target === e.currentTarget) closeEditor(); }}>
      <div className="bg-[var(--abu-bg-base)] rounded-2xl shadow-xl w-[480px] max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--abu-bg-active)] shrink-0">
          <h2 className="text-h-sm font-semibold text-[var(--abu-text-primary)]">
            {editingTriggerId ? t.trigger.editTrigger : t.trigger.newTrigger}
          </h2>
          <button
            onClick={closeEditor}
            className="p-1.5 rounded-lg text-[var(--abu-text-muted)] hover:text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-active)] transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Form */}
        <div className="px-6 py-4 space-y-4 overflow-auto flex-1">
          {/* Name */}
          <div>
            <label className="block text-body font-medium text-[var(--abu-text-primary)] mb-1.5">
              {t.trigger.triggerName}
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t.trigger.triggerNamePlaceholder}
              className={cn(
                'w-full h-10 px-3 bg-[var(--abu-bg-base)] border rounded-lg text-body text-[var(--abu-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)]',
                isDuplicateName ? 'border-[var(--abu-danger)]' : 'border-[var(--abu-border)]'
              )}
            />
            {isDuplicateName && (
              <p className="text-caption text-[var(--abu-danger)] mt-1">{t.trigger.duplicateName}</p>
            )}
          </div>

          {/* Description */}
          <div>
            <label className="block text-body font-medium text-[var(--abu-text-primary)] mb-1.5">
              {t.trigger.description}
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t.trigger.descriptionPlaceholder}
              rows={2}
              className="w-full px-3 py-2 bg-[var(--abu-bg-base)] border border-[var(--abu-border)] rounded-lg text-body text-[var(--abu-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)] resize-none"
            />
          </div>

          {/* Source type */}
          <div>
            <label className="block text-body font-medium text-[var(--abu-text-primary)] mb-1.5">
              {t.trigger.sourceType}
            </label>
            <div className="flex flex-wrap gap-1.5">
              {SOURCE_TYPES.map((st) => (
                <button
                  key={st}
                  onClick={() => setSourceType(st)}
                  className={cn(
                    'px-3 py-1.5 rounded-lg text-minor font-medium transition-colors',
                    sourceType === st
                      ? 'bg-[var(--abu-clay)] text-white'
                      : 'bg-[var(--abu-bg-muted)] text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-hover)]'
                  )}
                >
                  {st === 'http' ? t.trigger.sourceHttp : st === 'file' ? t.trigger.sourceFile : st === 'cron' ? t.trigger.sourceCron : t.trigger.imSource}
                </button>
              ))}
            </div>
          </div>

          {/* File source fields */}
          {sourceType === 'file' && (
            <>
              <div>
                <label className="block text-body font-medium text-[var(--abu-text-primary)] mb-1.5">
                  {t.trigger.filePath}
                </label>
                <input
                  type="text"
                  value={fileWatchPath}
                  onChange={(e) => setFileWatchPath(e.target.value)}
                  placeholder={t.trigger.filePathPlaceholder}
                  className="w-full h-10 px-3 bg-[var(--abu-bg-base)] border border-[var(--abu-border)] rounded-lg text-body text-[var(--abu-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)]"
                />
              </div>
              <div>
                <label className="block text-body font-medium text-[var(--abu-text-primary)] mb-1.5">
                  {t.trigger.fileEvents}
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {(['create', 'modify', 'delete'] as const).map((evt) => (
                    <button
                      key={evt}
                      onClick={() =>
                        setFileEvents((prev) =>
                          prev.includes(evt) ? prev.filter((e) => e !== evt) : [...prev, evt]
                        )
                      }
                      className={cn(
                        'px-3 py-1.5 rounded-lg text-minor font-medium transition-colors',
                        fileEvents.includes(evt)
                          ? 'bg-[var(--abu-clay)] text-white'
                          : 'bg-[var(--abu-bg-muted)] text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-hover)]'
                      )}
                    >
                      {evt === 'create' ? t.trigger.fileEventCreate : evt === 'modify' ? t.trigger.fileEventModify : t.trigger.fileEventDelete}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-body font-medium text-[var(--abu-text-primary)] mb-1.5">
                  {t.trigger.filePattern}
                </label>
                <input
                  type="text"
                  value={filePattern}
                  onChange={(e) => setFilePattern(e.target.value)}
                  placeholder={t.trigger.filePatternPlaceholder}
                  className="w-full h-10 px-3 bg-[var(--abu-bg-base)] border border-[var(--abu-border)] rounded-lg text-body text-[var(--abu-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)]"
                />
              </div>
            </>
          )}

          {/* Cron source fields */}
          {sourceType === 'cron' && (
            <div>
              <label className="block text-body font-medium text-[var(--abu-text-primary)] mb-1.5">
                {t.trigger.cronInterval}
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  value={cronInterval}
                  onChange={(e) => setCronInterval(Number(e.target.value) || 60)}
                  min={10}
                  placeholder={t.trigger.cronIntervalPlaceholder}
                  className="w-28 h-10 px-3 bg-[var(--abu-bg-base)] border border-[var(--abu-border)] rounded-lg text-body text-[var(--abu-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)]"
                />
                <span className="text-minor text-[var(--abu-text-tertiary)]">{t.trigger.seconds}</span>
              </div>
            </div>
          )}

          {/* IM source fields */}
          {sourceType === 'im' && (
            <>
              {/* IM Channel select */}
              <div>
                <label className="block text-body font-medium text-[var(--abu-text-primary)] mb-1.5">
                  {t.trigger.imSelectChannel}
                </label>
                {channelOptions.length > 0 ? (
                  <Select
                    value={imChannelId}
                    onChange={setImChannelId}
                    placeholder={t.trigger.imSelectChannel}
                    options={channelOptions}
                  />
                ) : (
                  <p className="text-minor text-[var(--abu-text-muted)] bg-[var(--abu-bg-muted)] rounded-lg px-3 py-2">
                    {t.trigger.imNoChannels}
                  </p>
                )}
              </div>

              {/* Listen scope */}
              <div>
                <label className="block text-minor text-[var(--abu-text-tertiary)] mb-1">{t.trigger.imListenScope}</label>
                <div className="space-y-1">
                  {([
                    ['mention_only', t.trigger.imScopeMentionOnly],
                    ['direct_only', t.trigger.imScopeDirectOnly],
                    ['all', t.trigger.imScopeAll],
                  ] as [IMListenScope, string][]).map(([scope, label]) => (
                    <label key={scope} className="flex items-center gap-2 text-minor text-[var(--abu-text-secondary)]">
                      <input
                        type="radio"
                        name="imListenScope"
                        checked={imListenScope === scope}
                        onChange={() => setImListenScope(scope)}
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </div>

              {/* Chat ID filter (optional) */}
              <div>
                <label className="block text-minor text-[var(--abu-text-tertiary)] mb-1">{t.trigger.imChatId}</label>
                <input
                  type="text"
                  value={imChatId}
                  onChange={(e) => setImChatId(e.target.value)}
                  placeholder={t.trigger.imChatIdPlaceholder}
                  className="w-full h-9 px-3 bg-[var(--abu-bg-base)] border border-[var(--abu-border)] rounded-lg text-body text-[var(--abu-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)]"
                />
              </div>

              {/* Sender match (optional) */}
              <div>
                <label className="block text-minor text-[var(--abu-text-tertiary)] mb-1">{t.trigger.senderMatch}</label>
                <input
                  type="text"
                  value={imSenderMatch}
                  onChange={(e) => setImSenderMatch(e.target.value)}
                  placeholder={t.trigger.senderMatchPlaceholder}
                  className="w-full h-9 px-3 bg-[var(--abu-bg-base)] border border-[var(--abu-border)] rounded-lg text-body text-[var(--abu-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)]"
                />
              </div>

              {/* Webhook callback URL (read-only) */}
              {selectedIMChannel && (
                <div>
                  <label className="block text-minor text-[var(--abu-text-tertiary)] mb-1">{t.trigger.imWebhookUrl}</label>
                  <div className="flex gap-2 items-center">
                    <input
                      type="text"
                      value={`http://127.0.0.1:${triggerEngine.getServerPort() ?? 18080}/im/${selectedIMChannel.platform}/webhook`}
                      readOnly
                      className="flex-1 h-9 px-3 bg-[var(--abu-bg-muted)] border border-[var(--abu-border)] rounded-lg text-minor text-[var(--abu-text-tertiary)] font-mono select-all"
                      onClick={(e) => (e.target as HTMLInputElement).select()}
                    />
                  </div>
                  <p className="text-caption text-[var(--abu-text-muted)] mt-1">{t.trigger.imWebhookUrlHint}</p>
                </div>
              )}
            </>
          )}

          {/* Prompt */}
          <div>
            <label className="block text-body font-medium text-[var(--abu-text-primary)] mb-1.5">
              {t.trigger.triggerPrompt}
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={t.trigger.triggerPromptPlaceholder}
              rows={4}
              className="w-full px-3 py-2 bg-[var(--abu-bg-base)] border border-[var(--abu-border)] rounded-lg text-body text-[var(--abu-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)] resize-none"
            />
            <p className="text-caption text-[var(--abu-text-muted)] mt-1">{t.trigger.promptHint}</p>
          </div>

          {/* Capability */}
          <div>
            <label className="block text-body font-medium text-[var(--abu-text-primary)] mb-1.5">
              {t.trigger.capability}
            </label>
            <Select
              value={capability}
              onChange={(value) => setCapability(value as TriggerCapability)}
              options={capabilityOptions}
              ariaLabel={t.trigger.capability}
            />
            <p className="text-caption text-[var(--abu-text-muted)] mt-1">
              {capabilityDescriptions[capability]}
            </p>
            <p className="text-caption text-[var(--abu-text-muted)] mt-1">
              {t.trigger.capabilityHint}
            </p>
            {capability === 'full' && (
              <p className="text-caption text-[var(--abu-warning)] mt-1">
                {t.trigger.capabilityFullWarning}
              </p>
            )}
          </div>

          {/* Filter type */}
          <div>
            <label className="block text-body font-medium text-[var(--abu-text-primary)] mb-1.5">
              {t.trigger.filterType}
            </label>
            <div className="flex flex-wrap gap-1.5">
              {FILTER_TYPES.map((ft) => (
                <button
                  key={ft}
                  onClick={() => setFilterType(ft)}
                  className={cn(
                    'px-3 py-1.5 rounded-lg text-minor font-medium transition-colors',
                    filterType === ft
                      ? 'bg-[var(--abu-clay)] text-white'
                      : 'bg-[var(--abu-bg-muted)] text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-hover)]'
                  )}
                >
                  {filterLabels[ft]}
                </button>
              ))}
            </div>
          </div>

          {/* Keywords input */}
          {filterType === 'keyword' && (
            <div>
              <label className="block text-body font-medium text-[var(--abu-text-primary)] mb-1.5">
                {t.trigger.keywords}
              </label>
              <input
                type="text"
                value={keywords}
                onChange={(e) => setKeywords(e.target.value)}
                placeholder={t.trigger.keywordsPlaceholder}
                className="w-full h-10 px-3 bg-[var(--abu-bg-base)] border border-[var(--abu-border)] rounded-lg text-body text-[var(--abu-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)]"
              />
            </div>
          )}

          {/* Regex input */}
          {filterType === 'regex' && (
            <div>
              <label className="block text-body font-medium text-[var(--abu-text-primary)] mb-1.5">
                {t.trigger.regexPattern}
              </label>
              <input
                type="text"
                value={regexPattern}
                onChange={(e) => setRegexPattern(e.target.value)}
                placeholder={t.trigger.regexPlaceholder}
                className="w-full h-10 px-3 bg-[var(--abu-bg-base)] border border-[var(--abu-border)] rounded-lg text-body text-[var(--abu-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)] font-mono"
              />
            </div>
          )}

          {/* Filter field */}
          {filterType !== 'always' && (
            <div>
              <label className="block text-body font-medium text-[var(--abu-text-primary)] mb-1.5">
                {t.trigger.filterField}
              </label>
              <input
                type="text"
                value={filterField}
                onChange={(e) => setFilterField(e.target.value)}
                placeholder={t.trigger.filterFieldPlaceholder}
                className="w-full h-10 px-3 bg-[var(--abu-bg-base)] border border-[var(--abu-border)] rounded-lg text-body text-[var(--abu-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)]"
              />
            </div>
          )}

          {/* Debounce */}
          <div>
            <label className="flex items-center gap-2 text-body font-medium text-[var(--abu-text-primary)] mb-1.5">
              <input
                type="checkbox"
                checked={debounceEnabled}
                onChange={(e) => setDebounceEnabled(e.target.checked)}
                className="rounded"
              />
              {t.trigger.debounceEnabled}
            </label>
            {debounceEnabled && (
              <div className="flex items-center gap-2 mt-1.5">
                <input
                  type="number"
                  value={debounceSeconds}
                  onChange={(e) => setDebounceSeconds(Number(e.target.value) || 0)}
                  min={0}
                  className="w-24 h-9 px-3 bg-[var(--abu-bg-base)] border border-[var(--abu-border)] rounded-lg text-body text-[var(--abu-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)]"
                />
                <span className="text-minor text-[var(--abu-text-tertiary)]">{t.trigger.seconds}</span>
              </div>
            )}
          </div>

          {/* Quiet hours */}
          <div>
            <label className="flex items-center gap-2 text-body font-medium text-[var(--abu-text-primary)] mb-1.5">
              <input
                type="checkbox"
                checked={quietHoursEnabled}
                onChange={(e) => setQuietHoursEnabled(e.target.checked)}
                className="rounded"
              />
              {t.trigger.quietHoursEnabled}
            </label>
            {quietHoursEnabled && (
              <div className="flex items-center gap-2 mt-1.5">
                <div className="flex items-center gap-1.5">
                  <span className="text-minor text-[var(--abu-text-tertiary)]">{t.trigger.quietHoursStart}</span>
                  <input
                    type="time"
                    value={quietHoursStart}
                    onChange={(e) => setQuietHoursStart(e.target.value)}
                    className="h-9 px-2 bg-[var(--abu-bg-base)] border border-[var(--abu-border)] rounded-lg text-body text-[var(--abu-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)]"
                  />
                </div>
                <span className="text-minor text-[var(--abu-text-tertiary)]">~</span>
                <div className="flex items-center gap-1.5">
                  <span className="text-minor text-[var(--abu-text-tertiary)]">{t.trigger.quietHoursEnd}</span>
                  <input
                    type="time"
                    value={quietHoursEnd}
                    onChange={(e) => setQuietHoursEnd(e.target.value)}
                    className="h-9 px-2 bg-[var(--abu-bg-base)] border border-[var(--abu-border)] rounded-lg text-body text-[var(--abu-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)]"
                  />
                </div>
              </div>
            )}
            {quietHoursEnabled && (
              <p className="text-caption text-[var(--abu-text-muted)] mt-1">{t.trigger.quietHoursHint}</p>
            )}
          </div>

          {/* Output config */}
          <div className="border-t border-[var(--abu-border)] pt-4">
            <label className="flex items-center gap-2 text-body font-medium text-[var(--abu-text-primary)] mb-1.5">
              <input
                type="checkbox"
                checked={outputEnabled}
                onChange={(e) => setOutputEnabled(e.target.checked)}
                className="rounded"
              />
              {t.trigger.enableOutput}
            </label>

            {outputEnabled && (
              <div className="space-y-3 mt-2 ml-0.5">
                {/* Output target (webhook vs im_channel) */}
                <div>
                  <div className="flex gap-1.5">
                    <button
                      onClick={() => setOutputTarget('webhook')}
                      className={cn(
                        'px-2.5 py-1 rounded-lg text-caption font-medium transition-colors',
                        outputTarget === 'webhook'
                          ? 'bg-[var(--abu-clay)] text-white'
                          : 'bg-[var(--abu-bg-muted)] text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-hover)]'
                      )}
                    >
                      {t.trigger.outputTargetWebhook}
                    </button>
                    <button
                      onClick={() => setOutputTarget('im_channel')}
                      className={cn(
                        'px-2.5 py-1 rounded-lg text-caption font-medium transition-colors',
                        outputTarget === 'im_channel'
                          ? 'bg-[var(--abu-clay)] text-white'
                          : 'bg-[var(--abu-bg-muted)] text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-hover)]'
                      )}
                    >
                      {t.trigger.outputTargetIMChannel}
                    </button>
                  </div>
                </div>

                {/* im_channel target: channel select + optional chat ID */}
                {outputTarget === 'im_channel' && (
                  <>
                    <div>
                      <label className="block text-minor text-[var(--abu-text-tertiary)] mb-1">
                        {t.trigger.outputSelectChannel}
                      </label>
                      {channelOptions.length > 0 ? (
                        <Select
                          value={outputChannelId}
                          onChange={setOutputChannelId}
                          placeholder={t.trigger.outputSelectChannel}
                          options={channelOptions}
                        />
                      ) : (
                        <p className="text-minor text-[var(--abu-text-muted)] bg-[var(--abu-bg-muted)] rounded-lg px-3 py-2">
                          {t.trigger.imNoChannels}
                        </p>
                      )}
                      {/*
                        This channel is also where the run ASKS. `triggerEngine`
                        builds the approval target from this same output config
                        (`core/im/approvalTarget.ts`), so a confirmation lands
                        where the results land — and with no channel chosen it
                        has nowhere to go and is refused. Said here rather than
                        left for the user to discover as a run that quietly
                        achieved nothing.
                      */}
                      <p className="text-caption text-[var(--abu-text-muted)] mt-1">
                        {t.trigger.outputChannelApprovalHint}
                      </p>
                    </div>
                    <div>
                      <label className="block text-minor text-[var(--abu-text-tertiary)] mb-1">{t.trigger.outputToGroup}</label>
                      <input
                        type="text"
                        value={outputChatIds}
                        onChange={(e) => setOutputChatIds(e.target.value)}
                        placeholder={t.trigger.outputChatIdPlaceholder}
                        className="w-full h-9 px-3 bg-[var(--abu-bg-base)] border border-[var(--abu-border)] rounded-lg text-body text-[var(--abu-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)]"
                      />
                    </div>
                    <div>
                      <label className="block text-minor text-[var(--abu-text-tertiary)] mb-1">{t.trigger.outputToDM}</label>
                      <input
                        type="text"
                        value={outputUserIds}
                        onChange={(e) => setOutputUserIds(e.target.value)}
                        placeholder={t.trigger.outputUserIdPlaceholder}
                        className="w-full h-9 px-3 bg-[var(--abu-bg-base)] border border-[var(--abu-border)] rounded-lg text-body text-[var(--abu-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)]"
                      />
                    </div>
                  </>
                )}

                {/* Platform select (only for webhook target) */}
                {outputTarget === 'webhook' && (
                <>
                <div>
                  <label className="block text-minor text-[var(--abu-text-tertiary)] mb-1">
                    {t.trigger.outputPlatform}
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    {getOutputPlatformOptions().map((opt) => (
                        <button
                          key={opt.value}
                          onClick={() => setOutputPlatform(opt.value as OutputPlatform)}
                          className={cn(
                            'px-2.5 py-1 rounded-lg text-caption font-medium transition-colors',
                            outputPlatform === opt.value
                              ? 'bg-[var(--abu-clay)] text-white'
                              : 'bg-[var(--abu-bg-muted)] text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-hover)]'
                          )}
                        >
                          {opt.label}
                        </button>
                    ))}
                  </div>
                </div>

                {/* Webhook URL */}
                <div>
                  <label className="block text-minor text-[var(--abu-text-tertiary)] mb-1">
                    {t.trigger.webhookUrl}
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={outputWebhookUrl}
                      onChange={(e) => setOutputWebhookUrl(e.target.value)}
                      placeholder={t.trigger.webhookUrlPlaceholder}
                      className="flex-1 h-9 px-3 bg-[var(--abu-bg-base)] border border-[var(--abu-border)] rounded-lg text-body text-[var(--abu-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)]"
                    />
                    <button
                      onClick={async () => {
                        if (!outputWebhookUrl.trim()) return;
                        setTestPushStatus('testing');
                        const headers: Record<string, string> = {};
                        if (outputCustomHeaders.trim()) {
                          for (const line of outputCustomHeaders.split('\n')) {
                            const idx = line.indexOf(':');
                            if (idx > 0) headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
                          }
                        }
                        const result = await outputSender.testSend(
                          outputPlatform,
                          outputWebhookUrl,
                          Object.keys(headers).length > 0 ? headers : undefined,
                        );
                        setTestPushStatus(result.success ? 'success' : 'error');
                        setTestPushError(result.error ?? '');
                        setTimeout(() => setTestPushStatus('idle'), 3000);
                      }}
                      disabled={!outputWebhookUrl.trim() || testPushStatus === 'testing'}
                      className={cn(
                        'px-3 py-1.5 rounded-lg text-caption font-medium transition-colors shrink-0',
                        outputWebhookUrl.trim()
                          ? 'bg-[var(--abu-bg-muted)] text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-hover)]'
                          : 'bg-[var(--abu-bg-muted)] text-[var(--abu-text-placeholder)] cursor-not-allowed'
                      )}
                    >
                      {t.trigger.testPush}
                    </button>
                  </div>
                  {testPushStatus === 'success' && (
                    <p className="text-caption text-[var(--abu-success)] mt-1">{t.trigger.testPushSuccess}</p>
                  )}
                  {testPushStatus === 'error' && (
                    <p className="text-caption text-[var(--abu-danger)] mt-1">{t.trigger.testPushFailed}: {testPushError}</p>
                  )}
                </div>

                {/* Custom Headers (only for 'custom' platform) */}
                {outputPlatform === 'custom' && (
                  <div>
                    <label className="block text-minor text-[var(--abu-text-tertiary)] mb-1">
                      {t.trigger.customHeaders}
                    </label>
                    <textarea
                      value={outputCustomHeaders}
                      onChange={(e) => setOutputCustomHeaders(e.target.value)}
                      placeholder={t.trigger.customHeadersPlaceholder}
                      rows={2}
                      className="w-full px-3 py-2 bg-[var(--abu-bg-base)] border border-[var(--abu-border)] rounded-lg text-minor text-[var(--abu-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)] resize-none font-mono"
                    />
                  </div>
                )}
                </>
                )}

                {/* Extract mode */}
                <div>
                  <label className="block text-minor text-[var(--abu-text-tertiary)] mb-1">
                    {t.trigger.extractMode}
                  </label>
                  <div className="space-y-1">
                    {([
                      ['last_message', t.trigger.extractLastMessage],
                      ['full', t.trigger.extractFull],
                      ['custom_template', t.trigger.extractTemplate],
                    ] as [OutputExtractMode, string][]).map(([mode, label]) => (
                      <label key={mode} className="flex items-center gap-2 text-minor text-[var(--abu-text-secondary)]">
                        <input
                          type="radio"
                          name="extractMode"
                          checked={outputExtractMode === mode}
                          onChange={() => setOutputExtractMode(mode)}
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                </div>

                {/* Custom template editor */}
                {outputExtractMode === 'custom_template' && (
                  <div>
                    <textarea
                      value={outputCustomTemplate}
                      onChange={(e) => setOutputCustomTemplate(e.target.value)}
                      placeholder={t.trigger.templatePlaceholder}
                      rows={3}
                      className="w-full px-3 py-2 bg-[var(--abu-bg-base)] border border-[var(--abu-border)] rounded-lg text-minor text-[var(--abu-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)] resize-none font-mono"
                    />
                    <p className="text-caption text-[var(--abu-text-muted)] mt-1">{t.trigger.templateVariables}</p>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Skill binding */}
          {skills.length > 0 && (
            <div>
              <label className="block text-body font-medium text-[var(--abu-text-primary)] mb-1.5">
                {t.trigger.bindSkill}
              </label>
              <Select
                value={skillName}
                onChange={setSkillName}
                placeholder={t.trigger.bindSkillNone}
                options={[
                  { value: '', label: t.trigger.bindSkillNone },
                  ...skills
                    .filter((s) => s.userInvocable)
                    .map((s) => ({ value: s.name, label: s.name })),
                ]}
              />
            </div>
          )}

          {/* Project selector */}
          {activeProjects.length > 0 && (
            <div>
              <label className="block text-body font-medium text-[var(--abu-text-primary)] mb-1.5">
                {t.project.projectLabel}
              </label>
              <Select
                value={projectId}
                onChange={(val) => {
                  setProjectId(val);
                  if (val) {
                    const proj = useProjectStore.getState().projects[val];
                    if (proj) setWorkspacePath(proj.workspacePath);
                  }
                }}
                options={[
                  { value: '', label: t.project.projectNone },
                  ...activeProjects.map((p) => ({
                    value: p.id,
                    label: p.name,
                  })),
                ]}
              />
            </div>
          )}

          {/* Workspace path */}
          <div>
            <label className="block text-body font-medium text-[var(--abu-text-primary)] mb-1.5">
              {t.trigger.workspacePath}
            </label>
            <input
              type="text"
              value={projectId ? (useProjectStore.getState().projects[projectId]?.workspacePath || workspacePath) : workspacePath}
              onChange={(e) => setWorkspacePath(e.target.value)}
              placeholder={t.trigger.workspacePathPlaceholder}
              disabled={!!projectId}
              className={cn(
                'w-full h-10 px-3 bg-[var(--abu-bg-base)] border border-[var(--abu-border)] rounded-lg text-body text-[var(--abu-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)]',
                projectId && 'opacity-60 cursor-not-allowed'
              )}
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-[var(--abu-bg-active)] shrink-0">
          <button
            onClick={closeEditor}
            className="px-4 py-2 rounded-lg text-body text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-muted)] transition-colors"
          >
            {t.common.cancel}
          </button>
          <button
            onClick={handleSave}
            disabled={!name.trim() || !prompt.trim() || (sourceType === 'file' && !fileWatchPath.trim()) || (sourceType === 'im' && !imChannelId) || !!isDuplicateName}
            className={cn(
              'px-4 py-2 rounded-lg text-body font-medium transition-colors',
              name.trim() && prompt.trim() && !(sourceType === 'file' && !fileWatchPath.trim()) && !(sourceType === 'im' && !imChannelId) && !isDuplicateName
                ? 'bg-[var(--abu-clay)] text-white hover:bg-[var(--abu-clay-hover)]'
                : 'bg-[var(--abu-border)] text-[var(--abu-text-tertiary)] cursor-not-allowed'
            )}
          >
            {t.common.save}
          </button>
        </div>
      </div>
    </div>
  );
}
