import { useState, useEffect } from 'react';
import { useTriggerStore } from '@/stores/triggerStore';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { useI18n } from '@/i18n';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Select } from '@/components/ui/select';
import { outputSender } from '@/core/im/outputSender';
import type { TriggerFilterType, TriggerSourceType, OutputPlatform, OutputExtractMode, IMPlatform, IMListenScope } from '@/types/trigger';
import { triggerEngine } from '@/core/trigger/triggerEngine';

const SOURCE_TYPES: TriggerSourceType[] = ['http', 'file', 'cron', 'im'];
const FILTER_TYPES: TriggerFilterType[] = ['always', 'keyword', 'regex'];

export default function TriggerEditor() {
  const { t } = useI18n();
  const { showEditor, editingTriggerId, editorTemplateDefaults, closeEditor, createTrigger, updateTrigger, triggers } =
    useTriggerStore();
  const skills = useDiscoveryStore((s) => s.skills);

  const editingTrigger = editingTriggerId ? triggers[editingTriggerId] : null;

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

  // IM source state
  const [imPlatform, setImPlatform] = useState<IMPlatform>('dchat');
  const [imAppId, setImAppId] = useState('');
  const [imAppSecret, setImAppSecret] = useState('');
  const [imListenScope, setImListenScope] = useState<IMListenScope>('mention_only');

  // Output config state
  const [outputEnabled, setOutputEnabled] = useState(false);
  const [outputTarget, setOutputTarget] = useState<'webhook' | 'reply_source'>('webhook');
  const [outputPlatform, setOutputPlatform] = useState<OutputPlatform>('dchat');
  const [outputWebhookUrl, setOutputWebhookUrl] = useState('');
  const [outputExtractMode, setOutputExtractMode] = useState<OutputExtractMode>('last_message');
  const [outputCustomTemplate, setOutputCustomTemplate] = useState('');
  const [outputCustomHeaders, setOutputCustomHeaders] = useState('');
  const [testPushStatus, setTestPushStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testPushError, setTestPushError] = useState('');

  // Initialize form when editing
  useEffect(() => {
    if (editingTrigger) {
      setName(editingTrigger.name);
      setDescription(editingTrigger.description ?? '');
      setPrompt(editingTrigger.action.prompt);
      setSourceType(editingTrigger.source.type);
      if (editingTrigger.source.type === 'file') {
        setFileWatchPath(editingTrigger.source.path);
        setFileEvents(editingTrigger.source.events);
        setFilePattern(editingTrigger.source.pattern ?? '');
      }
      if (editingTrigger.source.type === 'cron') {
        setCronInterval(editingTrigger.source.intervalSeconds);
      }
      if (editingTrigger.source.type === 'im') {
        setImPlatform(editingTrigger.source.platform);
        setImAppId(editingTrigger.source.appId);
        setImAppSecret(editingTrigger.source.appSecret);
        setImListenScope(editingTrigger.source.listenScope);
      }
      setFilterType(editingTrigger.filter.type);
      setKeywords((editingTrigger.filter.keywords ?? []).join(', '));
      setRegexPattern(editingTrigger.filter.pattern ?? '');
      setFilterField(editingTrigger.filter.field ?? '');
      setSkillName(editingTrigger.action.skillName ?? '');
      setWorkspacePath(editingTrigger.action.workspacePath ?? '');
      setDebounceEnabled(editingTrigger.debounce.enabled);
      setDebounceSeconds(editingTrigger.debounce.windowSeconds);
      setQuietHoursEnabled(editingTrigger.quietHours?.enabled ?? false);
      setQuietHoursStart(editingTrigger.quietHours?.start ?? '22:00');
      setQuietHoursEnd(editingTrigger.quietHours?.end ?? '08:00');
      setOutputEnabled(editingTrigger.output?.enabled ?? false);
      setOutputTarget(editingTrigger.output?.target ?? 'webhook');
      setOutputPlatform(editingTrigger.output?.platform ?? 'dchat');
      setOutputWebhookUrl(editingTrigger.output?.webhookUrl ?? '');
      setOutputExtractMode(editingTrigger.output?.extractMode ?? 'last_message');
      setOutputCustomTemplate(editingTrigger.output?.customTemplate ?? '');
      setOutputCustomHeaders(
        editingTrigger.output?.customHeaders
          ? Object.entries(editingTrigger.output.customHeaders).map(([k, v]) => `${k}: ${v}`).join('\n')
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
      setImPlatform('dchat');
      setImAppId('');
      setImAppSecret('');
      setImListenScope('mention_only');
      setFilterType(tpl?.filterType ?? 'always');
      setKeywords(tpl?.keywords ?? '');
      setRegexPattern('');
      setFilterField('');
      setSkillName('');
      setWorkspacePath('');
      setDebounceEnabled(true);
      setDebounceSeconds(300);
      setQuietHoursEnabled(false);
      setQuietHoursStart('22:00');
      setQuietHoursEnd('08:00');
      setOutputEnabled(false);
      setOutputTarget('webhook');
      setOutputPlatform('dchat');
      setOutputWebhookUrl('');
      setOutputExtractMode('last_message');
      setOutputCustomTemplate('');
      setOutputCustomHeaders('');
    }
    setTestPushStatus('idle');
    setTestPushError('');
  }, [editingTrigger, showEditor, editorTemplateDefaults]);

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

  const handleSave = () => {
    if (!name.trim() || !prompt.trim()) return;
    if (sourceType === 'file' && !fileWatchPath.trim()) return;
    if (sourceType === 'im' && (!imAppId.trim() || !imAppSecret.trim())) return;
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

    const action = {
      prompt: prompt.trim(),
      skillName: skillName || undefined,
      workspacePath: workspacePath || undefined,
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
            ? { type: 'im' as const, platform: imPlatform, appId: imAppId.trim(), appSecret: imAppSecret.trim(), listenScope: imListenScope }
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
      });
    } else {
      createTrigger({
        name: name.trim(),
        description: description.trim() || undefined,
        source,
        filter,
        action,
        debounce,
        quietHours,
        output,
      });
    }

    closeEditor();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={closeEditor}>
      <div className="bg-white rounded-2xl shadow-xl w-[480px] max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-100 shrink-0">
          <h2 className="text-[16px] font-semibold text-[#29261b]">
            {editingTriggerId ? t.trigger.editTrigger : t.trigger.newTrigger}
          </h2>
          <button
            onClick={closeEditor}
            className="p-1.5 rounded-lg text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Form */}
        <div className="px-6 py-4 space-y-4 overflow-auto flex-1">
          {/* Name */}
          <div>
            <label className="block text-[13px] font-medium text-[#29261b] mb-1.5">
              {t.trigger.triggerName}
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t.trigger.triggerNamePlaceholder}
              className={cn(
                'w-full h-10 px-3 bg-white border rounded-lg text-sm text-[#29261b] focus:outline-none focus:ring-2 focus:ring-[#d97757]/30 focus:border-[#d97757]',
                isDuplicateName ? 'border-red-400' : 'border-[#e8e4dd]'
              )}
            />
            {isDuplicateName && (
              <p className="text-[11px] text-red-500 mt-1">{t.trigger.duplicateName}</p>
            )}
          </div>

          {/* Description */}
          <div>
            <label className="block text-[13px] font-medium text-[#29261b] mb-1.5">
              {t.trigger.description}
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t.trigger.descriptionPlaceholder}
              rows={2}
              className="w-full px-3 py-2 bg-white border border-[#e8e4dd] rounded-lg text-sm text-[#29261b] focus:outline-none focus:ring-2 focus:ring-[#d97757]/30 focus:border-[#d97757] resize-none"
            />
          </div>

          {/* Source type */}
          <div>
            <label className="block text-[13px] font-medium text-[#29261b] mb-1.5">
              {t.trigger.sourceType}
            </label>
            <div className="flex flex-wrap gap-1.5">
              {SOURCE_TYPES.map((st) => (
                <button
                  key={st}
                  onClick={() => setSourceType(st)}
                  className={cn(
                    'px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors',
                    sourceType === st
                      ? 'bg-[#d97757] text-white'
                      : 'bg-[#f5f3ee] text-[#3d3929] hover:bg-[#e8e5de]'
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
                <label className="block text-[13px] font-medium text-[#29261b] mb-1.5">
                  {t.trigger.filePath}
                </label>
                <input
                  type="text"
                  value={fileWatchPath}
                  onChange={(e) => setFileWatchPath(e.target.value)}
                  placeholder={t.trigger.filePathPlaceholder}
                  className="w-full h-10 px-3 bg-white border border-[#e8e4dd] rounded-lg text-sm text-[#29261b] focus:outline-none focus:ring-2 focus:ring-[#d97757]/30 focus:border-[#d97757]"
                />
              </div>
              <div>
                <label className="block text-[13px] font-medium text-[#29261b] mb-1.5">
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
                        'px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors',
                        fileEvents.includes(evt)
                          ? 'bg-[#d97757] text-white'
                          : 'bg-[#f5f3ee] text-[#3d3929] hover:bg-[#e8e5de]'
                      )}
                    >
                      {evt === 'create' ? t.trigger.fileEventCreate : evt === 'modify' ? t.trigger.fileEventModify : t.trigger.fileEventDelete}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-[13px] font-medium text-[#29261b] mb-1.5">
                  {t.trigger.filePattern}
                </label>
                <input
                  type="text"
                  value={filePattern}
                  onChange={(e) => setFilePattern(e.target.value)}
                  placeholder={t.trigger.filePatternPlaceholder}
                  className="w-full h-10 px-3 bg-white border border-[#e8e4dd] rounded-lg text-sm text-[#29261b] focus:outline-none focus:ring-2 focus:ring-[#d97757]/30 focus:border-[#d97757]"
                />
              </div>
            </>
          )}

          {/* Cron source fields */}
          {sourceType === 'cron' && (
            <div>
              <label className="block text-[13px] font-medium text-[#29261b] mb-1.5">
                {t.trigger.cronInterval}
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  value={cronInterval}
                  onChange={(e) => setCronInterval(Number(e.target.value) || 60)}
                  min={10}
                  placeholder={t.trigger.cronIntervalPlaceholder}
                  className="w-28 h-10 px-3 bg-white border border-[#e8e4dd] rounded-lg text-sm text-[#29261b] focus:outline-none focus:ring-2 focus:ring-[#d97757]/30 focus:border-[#d97757]"
                />
                <span className="text-[12px] text-[#656358]">{t.trigger.seconds}</span>
              </div>
            </div>
          )}

          {/* IM source fields */}
          {sourceType === 'im' && (
            <>
              {/* IM Platform */}
              <div>
                <label className="block text-[13px] font-medium text-[#29261b] mb-1.5">
                  {t.trigger.imPlatform}
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {(['dchat', 'feishu', 'dingtalk', 'wecom', 'slack'] as IMPlatform[]).map((p) => {
                    const labels: Record<IMPlatform, string> = {
                      dchat: 'D-Chat', feishu: '飞书', dingtalk: '钉钉', wecom: '企业微信', slack: 'Slack',
                    };
                    return (
                      <button
                        key={p}
                        onClick={() => setImPlatform(p)}
                        className={cn(
                          'px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors',
                          imPlatform === p
                            ? 'bg-[#d97757] text-white'
                            : 'bg-[#f5f3ee] text-[#3d3929] hover:bg-[#e8e5de]'
                        )}
                      >
                        {labels[p]}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* App ID & Secret */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[12px] text-[#656358] mb-1">{t.trigger.imAppId}</label>
                  <input
                    type="text"
                    value={imAppId}
                    onChange={(e) => setImAppId(e.target.value)}
                    placeholder={t.trigger.imAppIdPlaceholder}
                    className="w-full h-9 px-3 bg-white border border-[#e8e4dd] rounded-lg text-sm text-[#29261b] focus:outline-none focus:ring-2 focus:ring-[#d97757]/30 focus:border-[#d97757]"
                  />
                </div>
                <div>
                  <label className="block text-[12px] text-[#656358] mb-1">{t.trigger.imAppSecret}</label>
                  <input
                    type="password"
                    value={imAppSecret}
                    onChange={(e) => setImAppSecret(e.target.value)}
                    placeholder={t.trigger.imAppSecretPlaceholder}
                    className="w-full h-9 px-3 bg-white border border-[#e8e4dd] rounded-lg text-sm text-[#29261b] focus:outline-none focus:ring-2 focus:ring-[#d97757]/30 focus:border-[#d97757]"
                  />
                </div>
              </div>

              {/* Listen scope */}
              <div>
                <label className="block text-[12px] text-[#656358] mb-1">{t.trigger.imListenScope}</label>
                <div className="space-y-1">
                  {([
                    ['mention_only', t.trigger.imScopeMentionOnly],
                    ['direct_only', t.trigger.imScopeDirectOnly],
                    ['all', t.trigger.imScopeAll],
                  ] as [IMListenScope, string][]).map(([scope, label]) => (
                    <label key={scope} className="flex items-center gap-2 text-[12px] text-[#3d3929]">
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

              {/* Webhook callback URL (read-only, for user to configure in IM platform) */}
              <div>
                <label className="block text-[12px] text-[#656358] mb-1">{t.trigger.imWebhookUrl}</label>
                <div className="flex gap-2 items-center">
                  <input
                    type="text"
                    value={`http://127.0.0.1:${triggerEngine.getServerPort() ?? 18080}/im/${imPlatform}/webhook`}
                    readOnly
                    className="flex-1 h-9 px-3 bg-[#f5f3ee] border border-[#e8e4dd] rounded-lg text-xs text-[#656358] font-mono select-all"
                    onClick={(e) => (e.target as HTMLInputElement).select()}
                  />
                </div>
                <p className="text-[10px] text-[#9a9689] mt-1">{t.trigger.imWebhookUrlHint}</p>
              </div>
            </>
          )}

          {/* Prompt */}
          <div>
            <label className="block text-[13px] font-medium text-[#29261b] mb-1.5">
              {t.trigger.triggerPrompt}
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={t.trigger.triggerPromptPlaceholder}
              rows={4}
              className="w-full px-3 py-2 bg-white border border-[#e8e4dd] rounded-lg text-sm text-[#29261b] focus:outline-none focus:ring-2 focus:ring-[#d97757]/30 focus:border-[#d97757] resize-none"
            />
            <p className="text-[11px] text-[#9a9689] mt-1">{t.trigger.promptHint}</p>
          </div>

          {/* Filter type */}
          <div>
            <label className="block text-[13px] font-medium text-[#29261b] mb-1.5">
              {t.trigger.filterType}
            </label>
            <div className="flex flex-wrap gap-1.5">
              {FILTER_TYPES.map((ft) => (
                <button
                  key={ft}
                  onClick={() => setFilterType(ft)}
                  className={cn(
                    'px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors',
                    filterType === ft
                      ? 'bg-[#d97757] text-white'
                      : 'bg-[#f5f3ee] text-[#3d3929] hover:bg-[#e8e5de]'
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
              <label className="block text-[13px] font-medium text-[#29261b] mb-1.5">
                {t.trigger.keywords}
              </label>
              <input
                type="text"
                value={keywords}
                onChange={(e) => setKeywords(e.target.value)}
                placeholder={t.trigger.keywordsPlaceholder}
                className="w-full h-10 px-3 bg-white border border-[#e8e4dd] rounded-lg text-sm text-[#29261b] focus:outline-none focus:ring-2 focus:ring-[#d97757]/30 focus:border-[#d97757]"
              />
            </div>
          )}

          {/* Regex input */}
          {filterType === 'regex' && (
            <div>
              <label className="block text-[13px] font-medium text-[#29261b] mb-1.5">
                {t.trigger.regexPattern}
              </label>
              <input
                type="text"
                value={regexPattern}
                onChange={(e) => setRegexPattern(e.target.value)}
                placeholder={t.trigger.regexPlaceholder}
                className="w-full h-10 px-3 bg-white border border-[#e8e4dd] rounded-lg text-sm text-[#29261b] focus:outline-none focus:ring-2 focus:ring-[#d97757]/30 focus:border-[#d97757] font-mono"
              />
            </div>
          )}

          {/* Filter field */}
          {filterType !== 'always' && (
            <div>
              <label className="block text-[13px] font-medium text-[#29261b] mb-1.5">
                {t.trigger.filterField}
              </label>
              <input
                type="text"
                value={filterField}
                onChange={(e) => setFilterField(e.target.value)}
                placeholder={t.trigger.filterFieldPlaceholder}
                className="w-full h-10 px-3 bg-white border border-[#e8e4dd] rounded-lg text-sm text-[#29261b] focus:outline-none focus:ring-2 focus:ring-[#d97757]/30 focus:border-[#d97757]"
              />
            </div>
          )}

          {/* Debounce */}
          <div>
            <label className="flex items-center gap-2 text-[13px] font-medium text-[#29261b] mb-1.5">
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
                  className="w-24 h-9 px-3 bg-white border border-[#e8e4dd] rounded-lg text-sm text-[#29261b] focus:outline-none focus:ring-2 focus:ring-[#d97757]/30 focus:border-[#d97757]"
                />
                <span className="text-[12px] text-[#656358]">{t.trigger.seconds}</span>
              </div>
            )}
          </div>

          {/* Quiet hours */}
          <div>
            <label className="flex items-center gap-2 text-[13px] font-medium text-[#29261b] mb-1.5">
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
                  <span className="text-[12px] text-[#656358]">{t.trigger.quietHoursStart}</span>
                  <input
                    type="time"
                    value={quietHoursStart}
                    onChange={(e) => setQuietHoursStart(e.target.value)}
                    className="h-9 px-2 bg-white border border-[#e8e4dd] rounded-lg text-sm text-[#29261b] focus:outline-none focus:ring-2 focus:ring-[#d97757]/30 focus:border-[#d97757]"
                  />
                </div>
                <span className="text-[12px] text-[#656358]">~</span>
                <div className="flex items-center gap-1.5">
                  <span className="text-[12px] text-[#656358]">{t.trigger.quietHoursEnd}</span>
                  <input
                    type="time"
                    value={quietHoursEnd}
                    onChange={(e) => setQuietHoursEnd(e.target.value)}
                    className="h-9 px-2 bg-white border border-[#e8e4dd] rounded-lg text-sm text-[#29261b] focus:outline-none focus:ring-2 focus:ring-[#d97757]/30 focus:border-[#d97757]"
                  />
                </div>
              </div>
            )}
            {quietHoursEnabled && (
              <p className="text-[11px] text-[#9a9689] mt-1">{t.trigger.quietHoursHint}</p>
            )}
          </div>

          {/* Output config */}
          <div className="border-t border-[#e8e4dd] pt-4">
            <label className="flex items-center gap-2 text-[13px] font-medium text-[#29261b] mb-1.5">
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
                {/* Output target (webhook vs reply_source) */}
                {sourceType === 'im' && (
                  <div>
                    <div className="flex gap-1.5">
                      <button
                        onClick={() => setOutputTarget('webhook')}
                        className={cn(
                          'px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors',
                          outputTarget === 'webhook'
                            ? 'bg-[#d97757] text-white'
                            : 'bg-[#f5f3ee] text-[#3d3929] hover:bg-[#e8e5de]'
                        )}
                      >
                        {t.trigger.outputTargetWebhook}
                      </button>
                      <button
                        onClick={() => setOutputTarget('reply_source')}
                        className={cn(
                          'px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors',
                          outputTarget === 'reply_source'
                            ? 'bg-[#d97757] text-white'
                            : 'bg-[#f5f3ee] text-[#3d3929] hover:bg-[#e8e5de]'
                        )}
                      >
                        {t.trigger.outputTargetReplySource}
                      </button>
                    </div>
                  </div>
                )}

                {/* Platform select (only for webhook target) */}
                {outputTarget === 'webhook' && (
                <>
                <div>
                  <label className="block text-[12px] text-[#656358] mb-1">
                    {t.trigger.outputPlatform}
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    {(['dchat', 'feishu', 'dingtalk', 'wecom', 'slack', 'custom'] as OutputPlatform[]).map((p) => {
                      const labels: Record<OutputPlatform, string> = {
                        dchat: 'D-Chat', feishu: '飞书', dingtalk: '钉钉',
                        wecom: '企业微信', slack: 'Slack', custom: 'HTTP',
                      };
                      return (
                        <button
                          key={p}
                          onClick={() => setOutputPlatform(p)}
                          className={cn(
                            'px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors',
                            outputPlatform === p
                              ? 'bg-[#d97757] text-white'
                              : 'bg-[#f5f3ee] text-[#3d3929] hover:bg-[#e8e5de]'
                          )}
                        >
                          {labels[p]}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Webhook URL */}
                <div>
                  <label className="block text-[12px] text-[#656358] mb-1">
                    {t.trigger.webhookUrl}
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={outputWebhookUrl}
                      onChange={(e) => setOutputWebhookUrl(e.target.value)}
                      placeholder={t.trigger.webhookUrlPlaceholder}
                      className="flex-1 h-9 px-3 bg-white border border-[#e8e4dd] rounded-lg text-sm text-[#29261b] focus:outline-none focus:ring-2 focus:ring-[#d97757]/30 focus:border-[#d97757]"
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
                        'px-3 py-1.5 rounded-lg text-[11px] font-medium transition-colors shrink-0',
                        outputWebhookUrl.trim()
                          ? 'bg-[#f5f3ee] text-[#3d3929] hover:bg-[#e8e5de]'
                          : 'bg-[#f5f3ee] text-[#b0ad9f] cursor-not-allowed'
                      )}
                    >
                      {t.trigger.testPush}
                    </button>
                  </div>
                  {testPushStatus === 'success' && (
                    <p className="text-[11px] text-green-600 mt-1">{t.trigger.testPushSuccess}</p>
                  )}
                  {testPushStatus === 'error' && (
                    <p className="text-[11px] text-red-500 mt-1">{t.trigger.testPushFailed}: {testPushError}</p>
                  )}
                </div>

                {/* Custom Headers (only for 'custom' platform) */}
                {outputPlatform === 'custom' && (
                  <div>
                    <label className="block text-[12px] text-[#656358] mb-1">
                      {t.trigger.customHeaders}
                    </label>
                    <textarea
                      value={outputCustomHeaders}
                      onChange={(e) => setOutputCustomHeaders(e.target.value)}
                      placeholder={t.trigger.customHeadersPlaceholder}
                      rows={2}
                      className="w-full px-3 py-2 bg-white border border-[#e8e4dd] rounded-lg text-xs text-[#29261b] focus:outline-none focus:ring-2 focus:ring-[#d97757]/30 focus:border-[#d97757] resize-none font-mono"
                    />
                  </div>
                )}
                </>
                )}

                {/* Extract mode */}
                <div>
                  <label className="block text-[12px] text-[#656358] mb-1">
                    {t.trigger.extractMode}
                  </label>
                  <div className="space-y-1">
                    {([
                      ['last_message', t.trigger.extractLastMessage],
                      ['full', t.trigger.extractFull],
                      ['custom_template', t.trigger.extractTemplate],
                    ] as [OutputExtractMode, string][]).map(([mode, label]) => (
                      <label key={mode} className="flex items-center gap-2 text-[12px] text-[#3d3929]">
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
                      className="w-full px-3 py-2 bg-white border border-[#e8e4dd] rounded-lg text-xs text-[#29261b] focus:outline-none focus:ring-2 focus:ring-[#d97757]/30 focus:border-[#d97757] resize-none font-mono"
                    />
                    <p className="text-[10px] text-[#9a9689] mt-1">{t.trigger.templateVariables}</p>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Skill binding */}
          {skills.length > 0 && (
            <div>
              <label className="block text-[13px] font-medium text-[#29261b] mb-1.5">
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

          {/* Workspace path */}
          <div>
            <label className="block text-[13px] font-medium text-[#29261b] mb-1.5">
              {t.trigger.workspacePath}
            </label>
            <input
              type="text"
              value={workspacePath}
              onChange={(e) => setWorkspacePath(e.target.value)}
              placeholder={t.trigger.workspacePathPlaceholder}
              className="w-full h-10 px-3 bg-white border border-[#e8e4dd] rounded-lg text-sm text-[#29261b] focus:outline-none focus:ring-2 focus:ring-[#d97757]/30 focus:border-[#d97757]"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-neutral-100 shrink-0">
          <button
            onClick={closeEditor}
            className="px-4 py-2 rounded-lg text-[13px] text-[#3d3929] hover:bg-[#f5f3ee] transition-colors"
          >
            {t.common.cancel}
          </button>
          <button
            onClick={handleSave}
            disabled={!name.trim() || !prompt.trim() || (sourceType === 'file' && !fileWatchPath.trim()) || !!isDuplicateName}
            className={cn(
              'px-4 py-2 rounded-lg text-[13px] font-medium transition-colors',
              name.trim() && prompt.trim() && !(sourceType === 'file' && !fileWatchPath.trim()) && !isDuplicateName
                ? 'bg-[#d97757] text-white hover:bg-[#c8664a]'
                : 'bg-[#e8e4dd] text-[#656358] cursor-not-allowed'
            )}
          >
            {t.common.save}
          </button>
        </div>
      </div>
    </div>
  );
}
