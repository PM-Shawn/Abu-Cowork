import { useState, useEffect } from 'react';
import { useTriggerStore } from '@/stores/triggerStore';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { useI18n } from '@/i18n';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Select } from '@/components/ui/select';
import type { TriggerFilterType, TriggerSourceType } from '@/types/trigger';

const SOURCE_TYPES: TriggerSourceType[] = ['http', 'file', 'cron'];
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
    }
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

    const source =
      sourceType === 'file'
        ? { type: 'file' as const, path: fileWatchPath, events: fileEvents as ('create' | 'modify' | 'delete')[], pattern: filePattern || undefined }
        : sourceType === 'cron'
          ? { type: 'cron' as const, intervalSeconds: Math.max(10, cronInterval) }
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
                  {st === 'http' ? t.trigger.sourceHttp : st === 'file' ? t.trigger.sourceFile : t.trigger.sourceCron}
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
