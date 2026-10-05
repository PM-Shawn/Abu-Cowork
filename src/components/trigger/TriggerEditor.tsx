import { useState, useEffect, useId, useMemo } from 'react';
import { Button, IconButton } from '@/components/ds/button';
import { Checkbox } from '@/components/ds/checkbox';
import { Dialog, DialogClose } from '@/components/ds/dialog';
import { AppIcons } from '@/components/ds/icons';
import { InlineMessage } from '@/components/ds/inline-message';
import { RadioGroup } from '@/components/ds/radio-group';
import { SegmentedControl } from '@/components/ds/segmented-control';
import { Select } from '@/components/ds/select';
import { TextArea } from '@/components/ds/text-area';
import { TextField } from '@/components/ds/text-field';
import { outputSender } from '@/core/im/outputSender';
import { getOutputPlatformOptions } from '@/core/im/platformLabels';
import { triggerEngine } from '@/core/trigger/triggerEngine';
import { normalizeTriggerCapability } from '@/core/trigger/triggerCapability';
import { useI18n } from '@/i18n';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { useIMChannelStore } from '@/stores/imChannelStore';
import { useProjectStore } from '@/stores/projectStore';
import { useTriggerStore } from '@/stores/triggerStore';
import type { EditorTemplateDefaults } from '@/stores/triggerStore';
import type { Trigger, TriggerCapability, TriggerFilterType, TriggerSourceType, OutputPlatform, OutputExtractMode } from '@/types/trigger';
import type { IMListenScope } from '@/types/trigger';

const SOURCE_TYPES: TriggerSourceType[] = ['http', 'file', 'cron', 'im'];
const FILTER_TYPES: TriggerFilterType[] = ['always', 'keyword', 'regex'];
const FILE_EVENTS = ['create', 'modify', 'delete'] as const;
const STANDARD_CAPABILITIES: Exclude<TriggerCapability, 'custom'>[] = ['read_tools', 'safe_tools', 'full'];

/** What a list shows as chosen while the field holds nothing: no skill, no project. A list
 *  option cannot have an empty value. */
const NONE = '__none__';

/** What the form holds. The window asks before closing once a field differs from what it opened with. */
interface Fields {
  name: string;
  description: string;
  prompt: string;
  sourceType: TriggerSourceType;
  fileWatchPath: string;
  fileEvents: string[];
  filePattern: string;
  cronInterval: number;
  // IM source — references a channel
  imChannelId: string;
  imListenScope: IMListenScope;
  imChatId: string;
  imSenderMatch: string;
  filterType: TriggerFilterType;
  keywords: string;
  regexPattern: string;
  filterField: string;
  skillName: string;
  workspacePath: string;
  projectId: string;
  debounceEnabled: boolean;
  debounceSeconds: number;
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
  capability: TriggerCapability;
  // Output config
  outputEnabled: boolean;
  outputTarget: 'webhook' | 'im_channel';
  outputPlatform: OutputPlatform;
  outputWebhookUrl: string;
  outputChannelId: string;
  outputChatIds: string;
  outputUserIds: string;
  outputExtractMode: OutputExtractMode;
  outputCustomTemplate: string;
  outputCustomHeaders: string;
}

/** The form for a listener being edited, or for a new one: blank, or filled from a template. */
function fieldsOf(trigger: Trigger | null, template: EditorTemplateDefaults | null): Fields {
  const source = trigger?.source;
  const file = source?.type === 'file' ? source : null;
  const im = source?.type === 'im' ? source : null;
  return {
    name: trigger ? trigger.name : template?.name ?? '',
    description: trigger?.description ?? '',
    prompt: trigger ? trigger.action.prompt : template?.prompt ?? '',
    sourceType: trigger ? trigger.source.type : template?.sourceType ?? 'http',
    fileWatchPath: file?.path ?? '',
    fileEvents: file?.events ?? ['create', 'modify'],
    filePattern: file?.pattern ?? '',
    cronInterval: source?.type === 'cron' ? source.intervalSeconds : 60,
    imChannelId: im?.channelId ?? '',
    imListenScope: im?.listenScope ?? 'mention_only',
    imChatId: im?.chatId ?? '',
    imSenderMatch: im?.senderMatch ?? '',
    filterType: trigger ? trigger.filter.type : template?.filterType ?? 'always',
    keywords: trigger ? (trigger.filter.keywords ?? []).join(', ') : template?.keywords ?? '',
    regexPattern: trigger?.filter.pattern ?? '',
    filterField: trigger?.filter.field ?? '',
    skillName: trigger?.action.skillName ?? '',
    workspacePath: trigger?.action.workspacePath ?? '',
    projectId: trigger?.projectId ?? '',
    debounceEnabled: trigger ? trigger.debounce.enabled : true,
    debounceSeconds: trigger ? trigger.debounce.windowSeconds : 300,
    quietHoursEnabled: trigger?.quietHours?.enabled ?? false,
    quietHoursStart: trigger?.quietHours?.start ?? '22:00',
    quietHoursEnd: trigger?.quietHours?.end ?? '08:00',
    capability: trigger ? normalizeTriggerCapability(trigger.action.capability) : 'read_tools',
    outputEnabled: trigger?.output?.enabled ?? false,
    outputTarget: trigger?.output?.target ?? 'webhook',
    outputPlatform: trigger?.output?.platform ?? 'dchat',
    outputWebhookUrl: trigger?.output?.webhookUrl ?? '',
    outputChannelId: trigger?.output?.outputChannelId ?? '',
    outputChatIds: trigger?.output?.outputChatIds ?? '',
    outputUserIds: trigger?.output?.outputUserIds ?? '',
    outputExtractMode: trigger?.output?.extractMode ?? 'last_message',
    outputCustomTemplate: trigger?.output?.customTemplate ?? '',
    outputCustomHeaders: trigger?.output?.customHeaders
      ? Object.entries(trigger.output.customHeaders).map(([k, v]) => `${k}: ${v}`).join('\n')
      : '',
  };
}

/** Whether a field holds what it held when the window opened. The file events are a list. */
function same(a: Fields[keyof Fields], b: Fields[keyof Fields]): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, index) => item === b[index]);
  return a === b;
}

/** Header lines of the custom webhook, one per line as "Key: Value". */
function parseHeaders(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (text.trim()) {
    for (const line of text.split('\n')) {
      const idx = line.indexOf(':');
      if (idx > 0) {
        headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
    }
  }
  return headers;
}

const FIELD_LABEL = 'mb-1 block text-ui-sm font-medium text-label-secondary';
const HINT = 'mt-1 text-caption text-label-tertiary';
// Said in place of a channel list when no channel exists yet.
const NO_CHANNELS = 'rounded-control bg-fill px-3 py-2 text-ui-sm text-label-tertiary';

/**
 * The window that creates an event listener or edits one. It stays mounted and is closed, not
 * removed, so it fades out showing what it showed; a save or a test push pressed in the fading
 * window does nothing. It asks before it discards what was typed.
 */
export default function TriggerEditor({ onCloseAutoFocus }: {
  // Runs once the window has gone, before the focus returns to what opened it (ds `Dialog`).
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const { t } = useI18n();
  const id = useId();
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
  const [fields, setFields] = useState<Fields>(() => fieldsOf(null, null));
  const set = <K extends keyof Fields>(key: K, value: Fields[K]) => setFields((prev) => ({ ...prev, [key]: value }));
  // What the fields held when the window opened.
  const [opened, setOpened] = useState<Fields | null>(null);
  // Which listener the window opened on, and whether it carried rules of the retired custom
  // level. Both stay as they are while the window fades out, like the fields.
  const [held, setHeld] = useState<{ id: string | null; custom: boolean }>({ id: null, custom: false });
  const [testPushStatus, setTestPushStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testPushError, setTestPushError] = useState('');
  const [copied, setCopied] = useState(false);

  const {
    name, description, prompt, sourceType, fileWatchPath, fileEvents, filePattern, cronInterval,
    imChannelId, imListenScope, imChatId, imSenderMatch, filterType, keywords, regexPattern, filterField,
    skillName, workspacePath, projectId, debounceEnabled, debounceSeconds, quietHoursEnabled, quietHoursStart,
    quietHoursEnd, capability, outputEnabled, outputTarget, outputPlatform, outputWebhookUrl, outputChannelId,
    outputChatIds, outputUserIds, outputExtractMode, outputCustomTemplate, outputCustomHeaders,
  } = fields;

  // Derive the selected IM channel's platform for webhook URL display
  const selectedIMChannel = imChannels.find((c) => c.id === imChannelId);

  // Initialize the form when the window opens. A change to the listener's runs while the window
  // is open leaves the form alone: the listener is read from the store here, not subscribed to.
  useEffect(() => {
    if (!showEditor) return;
    const triggerToEdit = editingTriggerId
      ? useTriggerStore.getState().triggers[editingTriggerId] ?? null
      : null;
    // Apply template defaults if provided, otherwise reset to blank
    const next = fieldsOf(triggerToEdit, triggerToEdit ? null : editorTemplateDefaults);
    setFields(next);
    setOpened(next);
    setHeld({ id: triggerToEdit ? triggerToEdit.id : null, custom: triggerToEdit !== null && next.capability === 'custom' });
    setTestPushStatus('idle');
    setTestPushError('');
    setCopied(false);
  }, [editingTriggerId, showEditor, editorTemplateDefaults]);

  // The listener the window is about: the store's while it is open, the held one while it fades.
  const editingId = showEditor ? editingTriggerId : held.id;
  const offersCustom = showEditor ? editingCapability === 'custom' : held.custom;

  // P0-3: Duplicate name check
  const isDuplicateName = name.trim() && Object.values(triggers).some(
    (t) => t.name === name.trim() && t.id !== editingId
  );

  const filterLabels: Record<TriggerFilterType, string> = {
    always: t.trigger.filterAlways,
    keyword: t.trigger.filterKeyword,
    regex: t.trigger.filterRegex,
  };
  const sourceLabels: Record<TriggerSourceType, string> = {
    http: t.trigger.sourceHttp,
    file: t.trigger.sourceFile,
    cron: t.trigger.sourceCron,
    im: t.trigger.imSource,
  };
  const fileEventLabels: Record<(typeof FILE_EVENTS)[number], string> = {
    create: t.trigger.fileEventCreate,
    modify: t.trigger.fileEventModify,
    delete: t.trigger.fileEventDelete,
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
  // Each level with what it allows; the rules of the retired custom level stay on offer only
  // for a listener that still has them.
  const capabilityOptions = [
    ...STANDARD_CAPABILITIES.map((cap) => ({ value: cap, label: capabilityLabels[cap], description: capabilityDescriptions[cap] })),
    ...(offersCustom
      ? [{ value: 'custom', label: t.trigger.capabilityCustomLegacy, description: t.trigger.capabilityCustomLegacyDescription }]
      : []),
  ];

  // Channel options for Select
  const channelOptions = imChannels.map((c) => ({
    value: c.id,
    label: `${c.name} (${c.platform})`,
  }));

  const imWebhookUrl = selectedIMChannel
    ? `http://127.0.0.1:${triggerEngine.getServerPort() ?? 18080}/im/${selectedIMChannel.platform}/webhook`
    : '';

  const dirty = showEditor && opened !== null && (Object.keys(opened) as (keyof Fields)[]).some((key) => !same(fields[key], opened[key]));

  const canSave = Boolean(name.trim()) && Boolean(prompt.trim())
    && !(sourceType === 'file' && !fileWatchPath.trim())
    && !(sourceType === 'im' && !imChannelId)
    && !isDuplicateName;

  const handleSave = () => {
    // The window stays on the page while it fades out; a key press there saves nothing.
    if (!showEditor) return;
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
    const parsedHeaders = parseHeaders(outputCustomHeaders);

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

  // Sends one test message to the webhook as it is typed.
  const handleTestPush = async () => {
    // A push cannot be taken back: the fading window sends none.
    if (!showEditor) return;
    if (!outputWebhookUrl.trim()) return;
    setTestPushStatus('testing');
    const headers = parseHeaders(outputCustomHeaders);
    const result = await outputSender.testSend(
      outputPlatform,
      outputWebhookUrl,
      Object.keys(headers).length > 0 ? headers : undefined,
    );
    setTestPushStatus(result.success ? 'success' : 'error');
    setTestPushError(result.error ?? '');
    setTimeout(() => setTestPushStatus('idle'), 3000);
  };

  // The callback address goes to the clipboard and nowhere else.
  const handleCopyWebhookUrl = async () => {
    try {
      await navigator.clipboard.writeText(imWebhookUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback
    }
  };

  return (
    <Dialog
      open={showEditor}
      onOpenChange={(next) => { if (!next) closeEditor(); }}
      title={editingId ? t.trigger.editTrigger : t.trigger.newTrigger}
      // Wide enough for the four sources in one row, in English as well; the same width as the task editor.
      size="lg"
      closeButton
      dirty={dirty}
      onCloseAutoFocus={onCloseAutoFocus}
      footer={(
        <>
          <DialogClose asChild><Button variant="plain">{t.common.cancel}</Button></DialogClose>
          <Button variant="primary" disabled={!canSave} onClick={handleSave}>
            {t.common.save}
          </Button>
        </>
      )}
    >
      <div className="space-y-4">
        {/* Name */}
        <div>
          <label htmlFor={`${id}-name`} className={FIELD_LABEL}>{t.trigger.triggerName}</label>
          <TextField
            id={`${id}-name`}
            value={name}
            onChange={(e) => set('name', e.target.value)}
            placeholder={t.trigger.triggerNamePlaceholder}
            invalid={Boolean(isDuplicateName)}
          />
          {isDuplicateName && (
            <div className="mt-1">
              <InlineMessage tone="danger">{t.trigger.duplicateName}</InlineMessage>
            </div>
          )}
        </div>

        {/* Description */}
        <div>
          <label htmlFor={`${id}-description`} className={FIELD_LABEL}>{t.trigger.description}</label>
          <TextArea
            id={`${id}-description`}
            value={description}
            onChange={(e) => set('description', e.target.value)}
            placeholder={t.trigger.descriptionPlaceholder}
            rows={2}
          />
        </div>

        {/* Source type */}
        <div>
          <div className={FIELD_LABEL}>{t.trigger.sourceType}</div>
          <SegmentedControl
            label={t.trigger.sourceType}
            value={sourceType}
            onValueChange={(next) => set('sourceType', next as TriggerSourceType)}
            options={SOURCE_TYPES.map((st) => ({ value: st, label: sourceLabels[st] }))}
          />
        </div>

        {/* File source fields */}
        {sourceType === 'file' && (
          <>
            <div>
              <label htmlFor={`${id}-file-path`} className={FIELD_LABEL}>{t.trigger.filePath}</label>
              <TextField
                id={`${id}-file-path`}
                value={fileWatchPath}
                onChange={(e) => set('fileWatchPath', e.target.value)}
                placeholder={t.trigger.filePathPlaceholder}
              />
            </div>
            <div>
              <div className={FIELD_LABEL}>{t.trigger.fileEvents}</div>
              {/* Any of the three can be on together. */}
              <div role="group" aria-label={t.trigger.fileEvents} className="flex flex-wrap items-center gap-4">
                {FILE_EVENTS.map((evt) => (
                  <Checkbox
                    key={evt}
                    checked={fileEvents.includes(evt)}
                    onCheckedChange={() =>
                      setFields((prev) => ({
                        ...prev,
                        fileEvents: prev.fileEvents.includes(evt) ? prev.fileEvents.filter((e) => e !== evt) : [...prev.fileEvents, evt],
                      }))
                    }
                    label={fileEventLabels[evt]}
                  />
                ))}
              </div>
            </div>
            <div>
              <label htmlFor={`${id}-file-pattern`} className={FIELD_LABEL}>{t.trigger.filePattern}</label>
              <TextField
                id={`${id}-file-pattern`}
                value={filePattern}
                onChange={(e) => set('filePattern', e.target.value)}
                placeholder={t.trigger.filePatternPlaceholder}
              />
            </div>
          </>
        )}

        {/* Cron source fields */}
        {sourceType === 'cron' && (
          <div>
            <label htmlFor={`${id}-cron`} className={FIELD_LABEL}>{t.trigger.cronInterval}</label>
            <div className="flex items-center gap-2">
              <TextField
                id={`${id}-cron`}
                type="number"
                value={cronInterval}
                onChange={(e) => set('cronInterval', Number(e.target.value) || 60)}
                min={10}
                placeholder={t.trigger.cronIntervalPlaceholder}
                className="w-28"
              />
              <span className="text-ui-sm text-label-tertiary">{t.trigger.seconds}</span>
            </div>
          </div>
        )}

        {/* IM source fields */}
        {sourceType === 'im' && (
          <>
            {/* IM Channel select */}
            <div>
              <div className={FIELD_LABEL}>{t.trigger.imSelectChannel}</div>
              {channelOptions.length > 0 ? (
                <Select
                  fullWidth
                  label={t.trigger.imSelectChannel}
                  value={imChannelId}
                  onValueChange={(next) => set('imChannelId', next)}
                  placeholder={t.trigger.imSelectChannel}
                  options={channelOptions}
                />
              ) : (
                <p className={NO_CHANNELS}>{t.trigger.imNoChannels}</p>
              )}
            </div>

            {/* Listen scope */}
            <div>
              <div className={FIELD_LABEL}>{t.trigger.imListenScope}</div>
              <RadioGroup
                label={t.trigger.imListenScope}
                value={imListenScope}
                onValueChange={(next) => set('imListenScope', next as IMListenScope)}
                options={[
                  { value: 'mention_only', label: t.trigger.imScopeMentionOnly },
                  { value: 'direct_only', label: t.trigger.imScopeDirectOnly },
                  { value: 'all', label: t.trigger.imScopeAll },
                ]}
              />
            </div>

            {/* Chat ID filter (optional) */}
            <div>
              <label htmlFor={`${id}-im-chat`} className={FIELD_LABEL}>{t.trigger.imChatId}</label>
              <TextField
                id={`${id}-im-chat`}
                value={imChatId}
                onChange={(e) => set('imChatId', e.target.value)}
                placeholder={t.trigger.imChatIdPlaceholder}
              />
            </div>

            {/* Sender match (optional) */}
            <div>
              <label htmlFor={`${id}-im-sender`} className={FIELD_LABEL}>{t.trigger.senderMatch}</label>
              <TextField
                id={`${id}-im-sender`}
                value={imSenderMatch}
                onChange={(e) => set('imSenderMatch', e.target.value)}
                placeholder={t.trigger.senderMatchPlaceholder}
              />
            </div>

            {/* Webhook callback URL (read-only) */}
            {selectedIMChannel && (
              <div>
                <label htmlFor={`${id}-im-webhook`} className={FIELD_LABEL}>{t.trigger.imWebhookUrl}</label>
                <div className="flex items-center gap-2">
                  <TextField
                    id={`${id}-im-webhook`}
                    value={imWebhookUrl}
                    readOnly
                    className="font-code"
                    onClick={(e) => (e.target as HTMLInputElement).select()}
                  />
                  <span className="flex shrink-0">
                    <IconButton
                      size="sm"
                      icon={copied ? AppIcons.done : AppIcons.copy}
                      label={t.trigger.copyEndpoint}
                      onClick={() => { void handleCopyWebhookUrl(); }}
                    />
                  </span>
                </div>
                <p className={HINT}>{t.trigger.imWebhookUrlHint}</p>
              </div>
            )}
          </>
        )}

        {/* Prompt */}
        <div>
          <label htmlFor={`${id}-prompt`} className={FIELD_LABEL}>{t.trigger.triggerPrompt}</label>
          <TextArea
            id={`${id}-prompt`}
            value={prompt}
            onChange={(e) => set('prompt', e.target.value)}
            placeholder={t.trigger.triggerPromptPlaceholder}
            rows={4}
          />
          <p className={HINT}>{t.trigger.promptHint}</p>
        </div>

        {/* Capability: what a run may do unattended. A closed list changes nothing on a key press. */}
        <div>
          <div className={FIELD_LABEL}>{t.trigger.capability}</div>
          <Select
            fullWidth
            label={t.trigger.capability}
            value={capability}
            onValueChange={(value) => set('capability', value as TriggerCapability)}
            options={capabilityOptions}
          />
          <p className={HINT}>{capabilityDescriptions[capability]}</p>
          <p className={HINT}>{t.trigger.capabilityHint}</p>
          {capability === 'full' && (
            <div className="mt-2">
              <InlineMessage tone="warning">{t.trigger.capabilityFullWarning}</InlineMessage>
            </div>
          )}
        </div>

        {/* Filter type */}
        <div>
          <div className={FIELD_LABEL}>{t.trigger.filterType}</div>
          <SegmentedControl
            label={t.trigger.filterType}
            value={filterType}
            onValueChange={(next) => set('filterType', next as TriggerFilterType)}
            options={FILTER_TYPES.map((ft) => ({ value: ft, label: filterLabels[ft] }))}
          />
        </div>

        {/* Keywords input */}
        {filterType === 'keyword' && (
          <div>
            <label htmlFor={`${id}-keywords`} className={FIELD_LABEL}>{t.trigger.keywords}</label>
            <TextField
              id={`${id}-keywords`}
              value={keywords}
              onChange={(e) => set('keywords', e.target.value)}
              placeholder={t.trigger.keywordsPlaceholder}
            />
          </div>
        )}

        {/* Regex input */}
        {filterType === 'regex' && (
          <div>
            <label htmlFor={`${id}-regex`} className={FIELD_LABEL}>{t.trigger.regexPattern}</label>
            <TextField
              id={`${id}-regex`}
              value={regexPattern}
              onChange={(e) => set('regexPattern', e.target.value)}
              placeholder={t.trigger.regexPlaceholder}
              className="font-code"
            />
          </div>
        )}

        {/* Filter field */}
        {filterType !== 'always' && (
          <div>
            <label htmlFor={`${id}-filter-field`} className={FIELD_LABEL}>{t.trigger.filterField}</label>
            <TextField
              id={`${id}-filter-field`}
              value={filterField}
              onChange={(e) => set('filterField', e.target.value)}
              placeholder={t.trigger.filterFieldPlaceholder}
            />
          </div>
        )}

        {/* Debounce */}
        <div>
          <Checkbox
            checked={debounceEnabled}
            onCheckedChange={(next) => set('debounceEnabled', next)}
            label={t.trigger.debounceEnabled}
          />
          {debounceEnabled && (
            <div className="mt-2 flex items-center gap-2">
              <TextField
                type="number"
                aria-label={t.trigger.debounce}
                value={debounceSeconds}
                onChange={(e) => set('debounceSeconds', Number(e.target.value) || 0)}
                min={0}
                className="w-24"
              />
              <span className="text-ui-sm text-label-tertiary">{t.trigger.seconds}</span>
            </div>
          )}
        </div>

        {/* Quiet hours */}
        <div>
          <Checkbox
            checked={quietHoursEnabled}
            onCheckedChange={(next) => set('quietHoursEnabled', next)}
            label={t.trigger.quietHoursEnabled}
          />
          {quietHoursEnabled && (
            <div className="mt-2 flex items-center gap-2">
              <label htmlFor={`${id}-quiet-start`} className="text-ui-sm text-label-tertiary">{t.trigger.quietHoursStart}</label>
              <TextField
                id={`${id}-quiet-start`}
                type="time"
                value={quietHoursStart}
                onChange={(e) => set('quietHoursStart', e.target.value)}
                className="w-32"
              />
              <span className="text-ui-sm text-label-tertiary">~</span>
              <label htmlFor={`${id}-quiet-end`} className="text-ui-sm text-label-tertiary">{t.trigger.quietHoursEnd}</label>
              <TextField
                id={`${id}-quiet-end`}
                type="time"
                value={quietHoursEnd}
                onChange={(e) => set('quietHoursEnd', e.target.value)}
                className="w-32"
              />
            </div>
          )}
          {quietHoursEnabled && (
            <p className={HINT}>{t.trigger.quietHoursHint}</p>
          )}
        </div>

        {/* Output config */}
        <div className="border-t border-separator pt-4">
          <Checkbox
            checked={outputEnabled}
            onCheckedChange={(next) => set('outputEnabled', next)}
            label={t.trigger.enableOutput}
          />

          {outputEnabled && (
            <div className="mt-3 space-y-3">
              {/* Output target (webhook vs im_channel) */}
              <SegmentedControl
                label={t.trigger.outputConfig}
                value={outputTarget}
                onValueChange={(next) => set('outputTarget', next as 'webhook' | 'im_channel')}
                options={[
                  { value: 'webhook', label: t.trigger.outputTargetWebhook },
                  { value: 'im_channel', label: t.trigger.outputTargetIMChannel },
                ]}
              />

              {/* im_channel target: channel select + optional chat ID */}
              {outputTarget === 'im_channel' && (
                <>
                  <div>
                    <div className={FIELD_LABEL}>{t.trigger.outputSelectChannel}</div>
                    {channelOptions.length > 0 ? (
                      <Select
                        fullWidth
                        label={t.trigger.outputSelectChannel}
                        value={outputChannelId}
                        onValueChange={(next) => set('outputChannelId', next)}
                        placeholder={t.trigger.outputSelectChannel}
                        options={channelOptions}
                      />
                    ) : (
                      <p className={NO_CHANNELS}>{t.trigger.imNoChannels}</p>
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
                    <p className={HINT}>{t.trigger.outputChannelApprovalHint}</p>
                  </div>
                  <div>
                    <label htmlFor={`${id}-output-chats`} className={FIELD_LABEL}>{t.trigger.outputToGroup}</label>
                    <TextField
                      id={`${id}-output-chats`}
                      value={outputChatIds}
                      onChange={(e) => set('outputChatIds', e.target.value)}
                      placeholder={t.trigger.outputChatIdPlaceholder}
                    />
                  </div>
                  <div>
                    <label htmlFor={`${id}-output-users`} className={FIELD_LABEL}>{t.trigger.outputToDM}</label>
                    <TextField
                      id={`${id}-output-users`}
                      value={outputUserIds}
                      onChange={(e) => set('outputUserIds', e.target.value)}
                      placeholder={t.trigger.outputUserIdPlaceholder}
                    />
                  </div>
                </>
              )}

              {/* Platform select (only for webhook target) */}
              {outputTarget === 'webhook' && (
                <>
                  <div>
                    <div className={FIELD_LABEL}>{t.trigger.outputPlatform}</div>
                    {/* A list, not a row: plugins add platforms, so their number is open. */}
                    <Select
                      fullWidth
                      label={t.trigger.outputPlatform}
                      value={outputPlatform}
                      onValueChange={(next) => set('outputPlatform', next as OutputPlatform)}
                      placeholder={t.trigger.outputPlatform}
                      options={getOutputPlatformOptions()}
                    />
                  </div>

                  {/* Webhook URL */}
                  <div>
                    <label htmlFor={`${id}-webhook`} className={FIELD_LABEL}>{t.trigger.webhookUrl}</label>
                    <div className="flex items-center gap-2">
                      <TextField
                        id={`${id}-webhook`}
                        value={outputWebhookUrl}
                        onChange={(e) => set('outputWebhookUrl', e.target.value)}
                        placeholder={t.trigger.webhookUrlPlaceholder}
                      />
                      {/* Busy while the push it started is on its way: the focus stays here. */}
                      <span className="flex shrink-0">
                        <Button
                          variant="secondary"
                          busy={testPushStatus === 'testing'}
                          disabled={!outputWebhookUrl.trim()}
                          onClick={() => { void handleTestPush(); }}
                        >
                          {t.trigger.testPush}
                        </Button>
                      </span>
                    </div>
                    {testPushStatus === 'success' && (
                      <div className="mt-2">
                        <InlineMessage tone="success">{t.trigger.testPushSuccess}</InlineMessage>
                      </div>
                    )}
                    {testPushStatus === 'error' && (
                      <div className="mt-2">
                        <InlineMessage tone="danger">{t.trigger.testPushFailed}: {testPushError}</InlineMessage>
                      </div>
                    )}
                  </div>

                  {/* Custom Headers (only for 'custom' platform) */}
                  {outputPlatform === 'custom' && (
                    <div>
                      <label htmlFor={`${id}-headers`} className={FIELD_LABEL}>{t.trigger.customHeaders}</label>
                      <TextArea
                        id={`${id}-headers`}
                        value={outputCustomHeaders}
                        onChange={(e) => set('outputCustomHeaders', e.target.value)}
                        placeholder={t.trigger.customHeadersPlaceholder}
                        rows={2}
                        className="font-code"
                      />
                    </div>
                  )}
                </>
              )}

              {/* Extract mode */}
              <div>
                <div className={FIELD_LABEL}>{t.trigger.extractMode}</div>
                <RadioGroup
                  label={t.trigger.extractMode}
                  value={outputExtractMode}
                  onValueChange={(next) => set('outputExtractMode', next as OutputExtractMode)}
                  options={[
                    { value: 'last_message', label: t.trigger.extractLastMessage },
                    { value: 'full', label: t.trigger.extractFull },
                    { value: 'custom_template', label: t.trigger.extractTemplate },
                  ]}
                />
              </div>

              {/* Custom template editor */}
              {outputExtractMode === 'custom_template' && (
                <div>
                  <TextArea
                    aria-label={t.trigger.extractTemplate}
                    value={outputCustomTemplate}
                    onChange={(e) => set('outputCustomTemplate', e.target.value)}
                    placeholder={t.trigger.templatePlaceholder}
                    rows={3}
                    className="font-code"
                  />
                  <p className={HINT}>{t.trigger.templateVariables}</p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Skill binding */}
        {skills.length > 0 && (
          <div>
            <div className={FIELD_LABEL}>{t.trigger.bindSkill}</div>
            <Select
              fullWidth
              label={t.trigger.bindSkill}
              value={skillName || NONE}
              onValueChange={(next) => set('skillName', next === NONE ? '' : next)}
              options={[
                { value: NONE, label: t.trigger.bindSkillNone },
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
            <div className={FIELD_LABEL}>{t.project.projectLabel}</div>
            <Select
              fullWidth
              label={t.project.projectLabel}
              value={projectId || NONE}
              onValueChange={(next) => {
                const val = next === NONE ? '' : next;
                set('projectId', val);
                if (val) {
                  const proj = useProjectStore.getState().projects[val];
                  if (proj) set('workspacePath', proj.workspacePath);
                }
              }}
              options={[
                { value: NONE, label: t.project.projectNone },
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
          <label htmlFor={`${id}-workspace`} className={FIELD_LABEL}>{t.trigger.workspacePath}</label>
          <TextField
            id={`${id}-workspace`}
            value={projectId ? (useProjectStore.getState().projects[projectId]?.workspacePath || workspacePath) : workspacePath}
            onChange={(e) => set('workspacePath', e.target.value)}
            placeholder={t.trigger.workspacePathPlaceholder}
            disabled={!!projectId}
          />
        </div>
      </div>
    </Dialog>
  );
}
