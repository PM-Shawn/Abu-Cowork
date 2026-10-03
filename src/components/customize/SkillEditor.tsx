import { useState, useEffect, useId, useRef } from 'react';
import { useI18n } from '@/i18n';
import { serializeSkillMd, skillLoader } from '@/core/skill/loader';
import { skillPolicyDenial } from '@/core/skill/skillPolicy';
import { navigateToChatWithInput } from '@/utils/navigation';
import { useItemName, isItemNameTaken } from '@/hooks/useItemName';
import { saveItemToAbuDir, ITEM_EXISTS_CODE, ITEM_NAME_INVALID_CODE } from '@/utils/itemStorage';
import { cn } from '@/lib/utils';
import { Button, IconButton } from '@/components/ds/button';
import { Disclosure } from '@/components/ds/disclosure';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { InlineMessage } from '@/components/ds/inline-message';
import { lastInputWasPointer } from '@/components/ds/input-modality';
import { Pressable } from '@/components/ds/pressable';
import { Select } from '@/components/ds/select';
import { Switch } from '@/components/ds/switch';
import { TextArea } from '@/components/ds/text-area';
import { TextField } from '@/components/ds/text-field';
import type { Skill, SkillMetadata } from '@/types';
import MarkdownRenderer from '@/components/chat/MarkdownRenderer';

/**
 * Every name a skill already answers to — user, project, drafts, builtin and
 * plugin skills including those of disabled plugins. A new or renamed skill
 * saved under one of these would overwrite the user's own SKILL.md, or be
 * shadowed by (or shadow) the skill the loader already resolves that name to.
 */
function skillNamesInUse(): string[] {
  return skillLoader.getAvailableSkills({ includeDrafts: true, includeDisabledPlugins: true }).map((s) => s.name);
}

const FIELD_LABEL = 'mb-1 block text-ui-sm font-medium text-label-secondary';
const FIELD_HINT = 'mt-1 text-caption text-danger';

interface SkillEditorProps {
  skill: Skill | null;  // null = creating new skill
  onClose: () => void;
  onSave: () => Promise<void>;
}

export default function SkillEditor({ skill, onClose, onSave }: SkillEditorProps) {
  const { t } = useI18n();
  const fieldId = useId();
  const [saving, setSaving] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  // The editor takes the place of the skill list: the focus goes to its way back.
  const backRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    backRef.current?.focus(lastInputWasPointer() ? { focusVisible: false } : undefined);
  }, []);

  // Name validation via shared hook
  const { name, setName, nameValid, nameTaken, nameChanged } = useItemName(skill?.name ?? null, {
    takenNames: skillNamesInUse(),
  });
  // The name refused at save time (it became taken after the last render, or a
  // SKILL.md is already on disk there): shown with the same hint.
  const [refusedName, setRefusedName] = useState<string | null>(null);
  const nameConflict = nameValid && (nameTaken || refusedName === name.trim());
  // The name the disk refused as not one plain folder name. The format check
  // blocks such names first, but an unchanged name is never re-checked — a
  // hand-edited frontmatter `name:` reaches the save as it is.
  const [invalidName, setInvalidName] = useState<string | null>(null);
  const nameRefusedAsInvalid = invalidName === name.trim();
  // The organization's policy blocks the name — renamed-to or kept: no save may
  // leave a skill answering to it. Asked on every render, so the hint follows
  // the name as it is typed; the name refused at save time stays flagged too.
  const [policyRefusedName, setPolicyRefusedName] = useState<string | null>(null);
  const namePolicyDenied = nameValid
    && (policyRefusedName === name.trim() || skillPolicyDenial(name.trim()) !== null);
  // Any other save failure: shown under the Save button, cleared on retry.
  const [saveFailed, setSaveFailed] = useState(false);
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
    const trimmed = name.trim();
    const creatingOrRenaming = !skill || nameChanged;
    if (creatingOrRenaming && isItemNameTaken(trimmed, skill?.name ?? null, skillNamesInUse())) {
      setRefusedName(trimmed);
      return false;
    }
    if (skillPolicyDenial(trimmed)) {
      setPolicyRefusedName(trimmed);
      return false;
    }
    setSaving(true);
    setSaveFailed(false);
    try {
      const metadata = buildMetadata();
      const md = serializeSkillMd(metadata, content);
      // Always the file being edited, renamed or not: its folder need not be
      // named after the skill, so an unchanged name could still point at another
      // skill's folder. saveItemToAbuDir writes this skill's own file in place,
      // wherever it lives (a project skill stays in its project), and on a
      // rename — and only a rename — moves its folder to the name within the
      // same parent (a move onto an occupied folder fails instead of
      // overwriting).
      const oldPath = skill?.filePath;
      // A letter-case-only rename moves this skill's own folder: on the
      // case-insensitive file systems the manifest already "at" the target is
      // its own, so the must-be-new probe would wrongly refuse it.
      const mustBeNew = !skill || (nameChanged && trimmed.toLowerCase() !== skill.name.toLowerCase());
      await saveItemToAbuDir('skills', 'SKILL.md', trimmed, md, oldPath, { mustBeNew, renaming: !!skill && nameChanged });
      await onSave();
      return true;
    } catch (err) {
      if ((err as { code?: unknown })?.code === ITEM_EXISTS_CODE) {
        setRefusedName(trimmed);
        return false;
      }
      if ((err as { code?: unknown })?.code === ITEM_NAME_INVALID_CODE) {
        setInvalidName(trimmed);
        return false;
      }
      console.error('[SkillEditor] Save failed:', err);
      setSaveFailed(true);
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

  const isValid = nameValid && !nameConflict && !nameRefusedAsInvalid && !namePolicyDenied;
  const nameWrong = Boolean(name.trim()) && (!nameValid || nameConflict || nameRefusedAsInvalid || namePolicyDenied);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-3 border-b border-separator px-4 py-3">
        <IconButton ref={backRef} icon={AppIcons.back} label={t.schedule.backToList} onClick={onClose} />
        <h2 className="flex-1 text-title text-label">{t.toolbox.skillEditorTitle}</h2>
        <div className="flex flex-wrap justify-end gap-x-2 gap-y-1">
          {/* Busy while a save runs, so the button pressed keeps the focus; disabled while the name cannot be saved. */}
          <Button variant="secondary" icon={AppIcons.save} busy={saving} disabled={!isValid} onClick={() => { void handleSave(); }}>
            {t.toolbox.skillSave}
          </Button>
          <Button variant="primary" icon={AppIcons.continue} busy={saving} disabled={!isValid} onClick={() => { void handleSaveAndTest(); }}>
            {t.toolbox.skillSaveAndTest}
          </Button>
          {saveFailed && (
            <div className="basis-full">
              <InlineMessage tone="danger">{t.toolbox.itemSaveFailed}</InlineMessage>
            </div>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {/* Basic Fields */}
        <div className="space-y-3">
          {/* Name */}
          <div>
            <label htmlFor={`${fieldId}-name`} className={FIELD_LABEL}>{t.toolbox.skillEditorName}</label>
            <TextField
              id={`${fieldId}-name`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-skill"
              invalid={nameWrong}
            />
            {name.trim() && (!nameValid || nameRefusedAsInvalid) && (
              <p className={FIELD_HINT}>{t.toolbox.nameFormatHint}</p>
            )}
            {nameConflict && (
              <p className={FIELD_HINT}>{t.toolbox.skillNameTakenHint}</p>
            )}
            {namePolicyDenied && (
              <p className={FIELD_HINT}>{t.toolbox.skillNamePolicyHint}</p>
            )}
          </div>

          {/* Description */}
          <div>
            <label htmlFor={`${fieldId}-description`} className={FIELD_LABEL}>{t.toolbox.skillEditorDescription}</label>
            <TextArea
              id={`${fieldId}-description`}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t.toolbox.skillEditorDescriptionPlaceholder}
              rows={2}
            />
          </div>
        </div>

        {/* Instructions */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label htmlFor={`${fieldId}-content`} className="block text-ui-sm font-medium text-label-secondary">{t.toolbox.skillEditorContent}</label>
            <Pressable
              aria-pressed={showPreview}
              onClick={() => setShowPreview(!showPreview)}
              className={cn(
                'inline-flex h-5 items-center rounded-control px-2 text-ui-sm font-medium',
                showPreview ? 'bg-fill-selected text-label' : 'bg-fill text-label-secondary hover:bg-fill-hover hover:text-label',
              )}
            >
              {t.toolbox.skillEditorPreview}
            </Pressable>
          </div>

          {showPreview ? (
            <div className="min-h-50 max-h-100 overflow-y-auto rounded-control border border-separator p-4">
              <MarkdownRenderer content={content || '*No content yet*'} />
            </div>
          ) : (
            <TextArea
              id={`${fieldId}-content`}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Write skill instructions in Markdown..."
              className="min-h-50 max-h-100 font-code"
            />
          )}
        </div>

        {/* Supporting Files */}
        {supportingFiles.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-ui-sm font-medium text-label-tertiary">
              {t.toolbox.skillFiles}
            </h3>
            <div className="rounded-control border border-separator p-3">
              <div className="space-y-1 font-code text-ui-sm">
                <div className="flex items-center gap-2 font-medium text-label">
                  <Icon icon={AppIcons.fileGeneric} size="sm" className="text-label-tertiary" />
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
                          <div className="mt-1 flex items-center gap-2 font-medium text-label">
                            <Icon icon={AppIcons.folder} size="sm" className="text-label-tertiary" />
                            {dir}
                          </div>
                          {files.map(f => (
                            <div key={f} className="flex items-center gap-2 pl-5 text-label-secondary">
                              <Icon icon={AppIcons.fileGeneric} size="sm" className="text-label-tertiary" />
                              {f}
                            </div>
                          ))}
                        </div>
                      ))}
                      {rootFiles.map(f => (
                        <div key={f} className="flex items-center gap-2 text-label-secondary">
                          <Icon icon={AppIcons.fileGeneric} size="sm" className="text-label-tertiary" />
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
        <Disclosure title={t.toolbox.skillAdvancedSettings}>
          <div className="space-y-3">
            {/* License */}
            <div>
              <label htmlFor={`${fieldId}-license`} className={FIELD_LABEL}>{t.toolbox.skillLicense}</label>
              <TextField id={`${fieldId}-license`} value={license} onChange={(e) => setLicense(e.target.value)} />
            </div>

            {/* Trigger */}
            <div>
              <label htmlFor={`${fieldId}-trigger`} className={FIELD_LABEL}>{t.toolbox.skillTrigger}</label>
              <TextField
                id={`${fieldId}-trigger`}
                value={trigger}
                onChange={(e) => setTrigger(e.target.value)}
                placeholder={t.toolbox.skillTriggerPlaceholder}
              />
            </div>

            {/* Do Not Trigger */}
            <div>
              <label htmlFor={`${fieldId}-do-not-trigger`} className={FIELD_LABEL}>{t.toolbox.skillDoNotTrigger}</label>
              <TextField
                id={`${fieldId}-do-not-trigger`}
                value={doNotTrigger}
                onChange={(e) => setDoNotTrigger(e.target.value)}
                placeholder={t.toolbox.skillDoNotTriggerPlaceholder}
              />
            </div>

            {/* Tags */}
            <div>
              <label htmlFor={`${fieldId}-tags`} className={FIELD_LABEL}>{t.toolbox.skillTags}</label>
              <TextField
                id={`${fieldId}-tags`}
                value={tagsStr}
                onChange={(e) => setTagsStr(e.target.value)}
                placeholder="research, analysis"
              />
            </div>

            {/* Context + Max Turns row */}
            <div className="flex gap-3">
              <div className="flex-1">
                {/* The select carries this text as its name. */}
                <div className={FIELD_LABEL}>{t.toolbox.skillContext}</div>
                <Select
                  fullWidth
                  label={t.toolbox.skillContext}
                  value={context}
                  onValueChange={(v) => setContext(v as 'inline' | 'fork')}
                  options={[
                    { value: 'inline', label: t.toolbox.skillContextInline },
                    { value: 'fork', label: t.toolbox.skillContextFork },
                  ]}
                />
              </div>
              <div className="w-32">
                <label htmlFor={`${fieldId}-max-turns`} className={FIELD_LABEL}>{t.toolbox.skillMaxTurns}</label>
                <TextField
                  id={`${fieldId}-max-turns`}
                  type="number"
                  min={1}
                  value={maxTurns}
                  onChange={(e) => {
                    const raw = e.target.value;
                    if (raw === '') { setMaxTurns(''); return; }
                    const v = parseInt(raw, 10);
                    if (!isNaN(v) && v >= 1) setMaxTurns(String(v));
                  }}
                  placeholder={t.toolbox.maxTurnsInheritGlobalHint}
                />
              </div>
            </div>

            {/* Allowed Tools */}
            <div>
              <label htmlFor={`${fieldId}-allowed-tools`} className={FIELD_LABEL}>{t.toolbox.skillAllowedTools}</label>
              <TextField
                id={`${fieldId}-allowed-tools`}
                value={allowedToolsStr}
                onChange={(e) => setAllowedToolsStr(e.target.value)}
                placeholder="read_file, write_file, web_search"
              />
            </div>

            {/* Argument Hint + User Invocable row */}
            <div className="flex items-end gap-3">
              <div className="flex-1">
                <label htmlFor={`${fieldId}-argument-hint`} className={FIELD_LABEL}>{t.toolbox.skillArgumentHint}</label>
                <TextField
                  id={`${fieldId}-argument-hint`}
                  value={argumentHint}
                  onChange={(e) => setArgumentHint(e.target.value)}
                  placeholder="<topic>"
                />
              </div>
              <div className="flex h-7 items-center gap-2">
                <label htmlFor={`${fieldId}-user-invocable`} className="text-ui-sm font-medium text-label-secondary">{t.toolbox.skillUserInvocable}</label>
                <Switch id={`${fieldId}-user-invocable`} checked={userInvocable} onCheckedChange={setUserInvocable} />
              </div>
            </div>
          </div>
        </Disclosure>
      </div>
    </div>
  );
}
