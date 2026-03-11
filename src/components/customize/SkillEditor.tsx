import { useState, useEffect } from 'react';
import { ArrowLeft, Save, Play, ChevronDown, ChevronRight, Folder, File } from 'lucide-react';
import { useI18n } from '@/i18n';
import { serializeSkillMd, skillLoader } from '@/core/skill/loader';
import { navigateToChatWithInput } from '@/utils/navigation';
import { useItemName } from '@/hooks/useItemName';
import { saveItemToAbuDir } from '@/utils/itemStorage';
import { cn } from '@/lib/utils';
import { Toggle } from '@/components/ui/toggle';
import { Select } from '@/components/ui/select';
import type { Skill, SkillMetadata } from '@/types';
import MarkdownRenderer from '@/components/chat/MarkdownRenderer';

interface SkillEditorProps {
  skill: Skill | null;  // null = creating new skill
  onClose: () => void;
  onSave: () => Promise<void>;
}

export default function SkillEditor({ skill, onClose, onSave }: SkillEditorProps) {
  const { t } = useI18n();
  const [saving, setSaving] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Name validation via shared hook
  const { name, setName, nameValid, nameChanged } = useItemName(skill?.name ?? null);
  const [description, setDescription] = useState(skill?.description ?? '');
  const [license, setLicense] = useState(skill?.license ?? '');
  const [trigger, setTrigger] = useState(skill?.trigger ?? '');
  const [doNotTrigger, setDoNotTrigger] = useState(skill?.doNotTrigger ?? '');
  const [tagsStr, setTagsStr] = useState((skill?.tags ?? []).join(', '));
  const [context, setContext] = useState<'inline' | 'fork'>(skill?.context ?? 'inline');
  const [userInvocable, setUserInvocable] = useState(skill?.userInvocable !== false);
  const [maxTurns, setMaxTurns] = useState(skill?.maxTurns?.toString() ?? '');
  const [allowedToolsStr, setAllowedToolsStr] = useState((skill?.allowedTools ?? []).join(', '));
  const [argumentHint, setArgumentHint] = useState(skill?.argumentHint ?? '');

  // Content state
  const [content, setContent] = useState(skill?.content ?? '');

  // Supporting files for file tree display
  const [supportingFiles, setSupportingFiles] = useState<string[]>([]);
  useEffect(() => {
    if (skill?.name) {
      skillLoader.listSupportingFiles(skill.name).then(files => setSupportingFiles(files));
    }
  }, [skill?.name]);

  const buildMetadata = (): Partial<SkillMetadata> => {
    const tags = tagsStr.split(',').map((t) => t.trim()).filter(Boolean);
    const allowedTools = allowedToolsStr.split(',').map((t) => t.trim()).filter(Boolean);
    return {
      name: name.trim(),
      description: description.trim(),
      license: license.trim() || undefined,
      trigger: trigger.trim() || undefined,
      doNotTrigger: doNotTrigger.trim() || undefined,
      userInvocable,
      context,
      maxTurns: maxTurns ? parseInt(maxTurns, 10) : undefined,
      allowedTools: allowedTools.length > 0 ? allowedTools : undefined,
      argumentHint: argumentHint.trim() || undefined,
      tags: tags.length > 0 ? tags : undefined,
    };
  };

  const handleSave = async (): Promise<boolean> => {
    if (!name.trim()) return false;
    setSaving(true);
    try {
      const metadata = buildMetadata();
      const md = serializeSkillMd(metadata, content);
      const oldPath = (skill?.filePath && nameChanged) ? skill.filePath : undefined;
      await saveItemToAbuDir('skills', 'SKILL.md', name.trim(), md, oldPath);
      await onSave();
      return true;
    } catch (err) {
      console.error('[SkillEditor] Save failed:', err);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const handleSaveAndTest = async () => {
    const ok = await handleSave();
    if (!ok) return;
    navigateToChatWithInput(`/${name.trim()} `);
  };

  const isValid = nameValid;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="shrink-0 flex items-center gap-3 px-4 py-3 border-b border-[#e8e4dd]/60">
        <button
          onClick={onClose}
          className="p-1.5 rounded-lg text-[#656358] hover:text-[#29261b] hover:bg-[#f5f3ee] transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <h2 className="text-sm font-semibold text-[#29261b] flex-1">{t.toolbox.skillEditorTitle}</h2>
        <div className="flex gap-2">
          <button
            onClick={handleSave}
            disabled={!isValid || saving}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-[#29261b] text-[#faf9f5] hover:bg-[#3d3a2f] disabled:opacity-50 transition-colors"
          >
            <Save className="h-3.5 w-3.5" />
            {t.toolbox.skillSave}
          </button>
          <button
            onClick={handleSaveAndTest}
            disabled={!isValid || saving}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-[#d97757] text-white hover:bg-[#c5664a] disabled:opacity-50 transition-colors"
          >
            <Play className="h-3.5 w-3.5" />
            {t.toolbox.skillSaveAndTest}
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {/* Basic Fields */}
        <div className="space-y-3">
          {/* Name */}
          <div>
            <label className="block text-xs font-medium text-[#29261b]/70 mb-1">{t.toolbox.skillEditorName}</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-skill"
              className={cn(
                'w-full px-3 py-1.5 rounded-lg border text-sm text-[#29261b] bg-white focus:outline-none focus:ring-2 focus:ring-[#d97757]/30 focus:border-[#d97757] transition-all',
                name.trim() && !nameValid ? 'border-red-300' : 'border-[#e8e4dd]',
              )}
            />
            {name.trim() && !nameValid && (
              <p className="text-[11px] text-red-500 mt-1">{t.toolbox.nameFormatHint}</p>
            )}
          </div>

          {/* Description */}
          <div>
            <label className="block text-xs font-medium text-[#29261b]/70 mb-1">{t.toolbox.skillEditorDescription}</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t.toolbox.skillEditorDescriptionPlaceholder}
              rows={2}
              className="w-full px-3 py-1.5 rounded-lg border border-[#e8e4dd] text-sm text-[#29261b] bg-white focus:outline-none focus:ring-2 focus:ring-[#d97757]/30 focus:border-[#d97757] transition-all resize-none"
            />
          </div>
        </div>

        {/* Instructions */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="block text-xs font-medium text-[#29261b]/70">{t.toolbox.skillEditorContent}</label>
            <button
              onClick={() => setShowPreview(!showPreview)}
              className={`text-[11px] px-2 py-0.5 rounded-full transition-colors ${
                showPreview
                  ? 'bg-[#29261b] text-[#faf9f5]'
                  : 'bg-[#f5f3ee] text-[#656358] hover:bg-[#e8e4dd]'
              }`}
            >
              {t.toolbox.skillEditorPreview}
            </button>
          </div>

          {showPreview ? (
            <div className="border border-[#e8e4dd] rounded-lg p-4 bg-[#faf9f5] min-h-[200px] max-h-[400px] overflow-y-auto">
              <MarkdownRenderer content={content || '*No content yet*'} />
            </div>
          ) : (
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Write skill instructions in Markdown..."
              className="w-full min-h-[200px] max-h-[400px] px-3 py-2 rounded-lg border border-[#e8e4dd] text-sm text-[#29261b] bg-white font-mono focus:outline-none focus:ring-2 focus:ring-[#d97757]/30 focus:border-[#d97757] transition-all resize-y"
            />
          )}
        </div>

        {/* Supporting Files */}
        {supportingFiles.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-xs font-semibold text-[#656358] uppercase tracking-wide">
              {t.toolbox.skillFiles}
            </h3>
            <div className="border border-[#e8e4dd] rounded-lg p-3 bg-[#faf9f5]">
              <div className="text-xs font-mono space-y-0.5">
                <div className="flex items-center gap-1.5 text-[#29261b] font-medium">
                  <File className="h-3 w-3 text-[#656358]" />
                  SKILL.md
                </div>
                {(() => {
                  // Group files by top-level directory
                  const dirs = new Map<string, string[]>();
                  const rootFiles: string[] = [];
                  for (const f of supportingFiles) {
                    const sep = f.indexOf('/');
                    if (sep === -1) {
                      rootFiles.push(f);
                    } else {
                      const dir = f.substring(0, sep);
                      if (!dirs.has(dir)) dirs.set(dir, []);
                      dirs.get(dir)!.push(f.substring(sep + 1));
                    }
                  }
                  return (
                    <>
                      {Array.from(dirs.entries()).map(([dir, files]) => (
                        <div key={dir}>
                          <div className="flex items-center gap-1.5 text-[#29261b] font-medium mt-1">
                            <Folder className="h-3 w-3 text-[#d97757]" />
                            {dir}
                          </div>
                          {files.map(f => (
                            <div key={f} className="flex items-center gap-1.5 text-[#656358] pl-5">
                              <File className="h-3 w-3 text-[#656358]/50" />
                              {f}
                            </div>
                          ))}
                        </div>
                      ))}
                      {rootFiles.map(f => (
                        <div key={f} className="flex items-center gap-1.5 text-[#656358]">
                          <File className="h-3 w-3 text-[#656358]/50" />
                          {f}
                        </div>
                      ))}
                    </>
                  );
                })()}
              </div>
            </div>
          </div>
        )}

        {/* Advanced Settings (collapsible) */}
        <div className="space-y-3">
          <button
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="flex items-center gap-1.5 text-xs font-semibold text-[#656358] uppercase tracking-wide hover:text-[#29261b] transition-colors"
          >
            {showAdvanced ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            {t.toolbox.skillAdvancedSettings}
          </button>

          {showAdvanced && (
            <div className="space-y-3">
              {/* License */}
              <div>
                <label className="block text-xs font-medium text-[#29261b]/70 mb-1">{t.toolbox.skillLicense}</label>
                <input
                  type="text"
                  value={license}
                  onChange={(e) => setLicense(e.target.value)}
                  className="w-full px-3 py-1.5 rounded-lg border border-[#e8e4dd] text-sm text-[#29261b] bg-white focus:outline-none focus:ring-2 focus:ring-[#d97757]/30 focus:border-[#d97757] transition-all"
                />
              </div>

              {/* Trigger */}
              <div>
                <label className="block text-xs font-medium text-[#29261b]/70 mb-1">{t.toolbox.skillTrigger}</label>
                <input
                  type="text"
                  value={trigger}
                  onChange={(e) => setTrigger(e.target.value)}
                  placeholder="用户要求深度调研某个主题"
                  className="w-full px-3 py-1.5 rounded-lg border border-[#e8e4dd] text-sm text-[#29261b] bg-white focus:outline-none focus:ring-2 focus:ring-[#d97757]/30 focus:border-[#d97757] transition-all"
                />
              </div>

              {/* Do Not Trigger */}
              <div>
                <label className="block text-xs font-medium text-[#29261b]/70 mb-1">{t.toolbox.skillDoNotTrigger}</label>
                <input
                  type="text"
                  value={doNotTrigger}
                  onChange={(e) => setDoNotTrigger(e.target.value)}
                  placeholder="用户只是问一个简单问题"
                  className="w-full px-3 py-1.5 rounded-lg border border-[#e8e4dd] text-sm text-[#29261b] bg-white focus:outline-none focus:ring-2 focus:ring-[#d97757]/30 focus:border-[#d97757] transition-all"
                />
              </div>

              {/* Tags */}
              <div>
                <label className="block text-xs font-medium text-[#29261b]/70 mb-1">{t.toolbox.skillTags}</label>
                <input
                  type="text"
                  value={tagsStr}
                  onChange={(e) => setTagsStr(e.target.value)}
                  placeholder="research, analysis"
                  className="w-full px-3 py-1.5 rounded-lg border border-[#e8e4dd] text-sm text-[#29261b] bg-white focus:outline-none focus:ring-2 focus:ring-[#d97757]/30 focus:border-[#d97757] transition-all"
                />
              </div>

              {/* Context + Max Turns row */}
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="block text-xs font-medium text-[#29261b]/70 mb-1">{t.toolbox.skillContext}</label>
                  <Select
                    value={context}
                    onChange={(v) => setContext(v as 'inline' | 'fork')}
                    options={[
                      { value: 'inline', label: t.toolbox.skillContextInline },
                      { value: 'fork', label: t.toolbox.skillContextFork },
                    ]}
                  />
                </div>
                <div className="w-24">
                  <label className="block text-xs font-medium text-[#29261b]/70 mb-1">{t.toolbox.skillMaxTurns}</label>
                  <input
                    type="number"
                    value={maxTurns}
                    onChange={(e) => setMaxTurns(e.target.value)}
                    placeholder="20"
                    className="w-full px-3 py-1.5 rounded-lg border border-[#e8e4dd] text-sm text-[#29261b] bg-white focus:outline-none focus:ring-2 focus:ring-[#d97757]/30 focus:border-[#d97757] transition-all"
                  />
                </div>
              </div>

              {/* Allowed Tools */}
              <div>
                <label className="block text-xs font-medium text-[#29261b]/70 mb-1">{t.toolbox.skillAllowedTools}</label>
                <input
                  type="text"
                  value={allowedToolsStr}
                  onChange={(e) => setAllowedToolsStr(e.target.value)}
                  placeholder="read_file, write_file, web_search"
                  className="w-full px-3 py-1.5 rounded-lg border border-[#e8e4dd] text-sm text-[#29261b] bg-white focus:outline-none focus:ring-2 focus:ring-[#d97757]/30 focus:border-[#d97757] transition-all"
                />
              </div>

              {/* Argument Hint + User Invocable row */}
              <div className="flex gap-3 items-end">
                <div className="flex-1">
                  <label className="block text-xs font-medium text-[#29261b]/70 mb-1">{t.toolbox.skillArgumentHint}</label>
                  <input
                    type="text"
                    value={argumentHint}
                    onChange={(e) => setArgumentHint(e.target.value)}
                    placeholder="<topic>"
                    className="w-full px-3 py-1.5 rounded-lg border border-[#e8e4dd] text-sm text-[#29261b] bg-white focus:outline-none focus:ring-2 focus:ring-[#d97757]/30 focus:border-[#d97757] transition-all"
                  />
                </div>
                <div className="flex items-center gap-2 pb-1">
                  <label className="text-xs font-medium text-[#29261b]/70">{t.toolbox.skillUserInvocable}</label>
                  <Toggle checked={userInvocable} onChange={() => setUserInvocable(!userInvocable)} size="md" />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
