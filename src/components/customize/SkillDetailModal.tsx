import { useState, useEffect } from 'react';
import { X, Wand2, Zap, ZapOff, Tag, Wrench, Layers, RotateCcw, Download, Pencil, FolderTree } from 'lucide-react';
import { useI18n } from '@/i18n';
import MarkdownRenderer from '@/components/chat/MarkdownRenderer';
import type { Skill } from '@/types';
import type { MarketplaceItem } from '@/types/marketplace';
import { skillLoader } from '@/core/skill/loader';

interface SkillDetailModalProps {
  skill: Skill | null;
  template: MarketplaceItem | null;
  isInstalled: boolean;
  onClose: () => void;
  onInstall?: () => void;
  onEdit?: () => void;
}

export default function SkillDetailModal({
  skill,
  template,
  isInstalled,
  onClose,
  onInstall,
  onEdit,
}: SkillDetailModalProps) {
  const { t } = useI18n();
  const [supportingFiles, setSupportingFiles] = useState<string[]>([]);

  // Load supporting files when skill is shown
  useEffect(() => {
    if (skill) {
      skillLoader.listSupportingFiles(skill.name).then(files => setSupportingFiles(files));
    } else {
      setSupportingFiles([]);
    }
  }, [skill]);

  // Escape key to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Derive display data from either installed skill or template
  const name = skill?.name ?? template?.name ?? '';
  const description = skill?.description ?? template?.description ?? '';
  const addedBy = skill?.filePath?.includes('builtin-skills') ? 'Anthropic' : 'User';

  // For templates, try to parse the SKILL.md content for metadata
  let trigger: string | undefined;
  let doNotTrigger: string | undefined;
  let tags: string[] | undefined;
  let allowedTools: string[] | undefined;
  let context: string | undefined;
  let maxTurns: number | undefined;
  let content: string | undefined;
  let license: string | undefined;

  if (skill) {
    trigger = skill.trigger;
    doNotTrigger = skill.doNotTrigger;
    tags = skill.tags;
    allowedTools = skill.allowedTools;
    context = skill.context;
    maxTurns = skill.maxTurns;
    content = skill.content;
    license = skill.license;
  } else if (template?.content) {
    // Parse the template SKILL.md to extract metadata
    const parsedSkill = skillLoader.getSkill(template.name);
    if (parsedSkill) {
      trigger = parsedSkill.trigger;
      doNotTrigger = parsedSkill.doNotTrigger;
      tags = parsedSkill.tags;
      allowedTools = parsedSkill.allowedTools;
      context = parsedSkill.context;
      maxTurns = parsedSkill.maxTurns;
      content = parsedSkill.content;
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[80vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--abu-bg-active)]">
          <div className="flex items-center gap-2">
            <Wand2 className="h-5 w-5 text-purple-500" />
            <h2 className="text-base font-semibold text-[var(--abu-text-primary)]">{name}</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-[var(--abu-text-muted)] hover:text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-active)] transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Added by */}
          <div className="text-xs text-[var(--abu-text-muted)]">{t.toolbox.skillAddedBy}: {addedBy}</div>

          {/* Description */}
          <p className="text-sm text-[var(--abu-text-secondary)]">{description}</p>

          {/* License */}
          {license && (
            <div className="px-3 py-2 rounded-lg bg-[var(--abu-bg-muted)] border border-[var(--abu-border)]/60">
              <div className="text-xs font-medium text-[var(--abu-text-tertiary)] mb-0.5">{t.toolbox.skillLicense}</div>
              <p className="text-xs text-[var(--abu-text-secondary)]">{license}</p>
            </div>
          )}

          {/* Trigger */}
          {trigger && (
            <div className="space-y-1">
              <div className="flex items-center gap-1.5 text-xs font-medium text-green-700">
                <Zap className="h-3.5 w-3.5" />
                {t.toolbox.skillTrigger}
              </div>
              <p className="text-xs text-[var(--abu-text-secondary)] pl-5">{trigger}</p>
            </div>
          )}

          {/* Do Not Trigger */}
          {doNotTrigger && (
            <div className="space-y-1">
              <div className="flex items-center gap-1.5 text-xs font-medium text-red-600">
                <ZapOff className="h-3.5 w-3.5" />
                {t.toolbox.skillDoNotTrigger}
              </div>
              <p className="text-xs text-[var(--abu-text-secondary)] pl-5">{doNotTrigger}</p>
            </div>
          )}

          {/* Tags */}
          {tags && tags.length > 0 && (
            <div className="space-y-1">
              <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--abu-text-tertiary)]">
                <Tag className="h-3.5 w-3.5" />
                {t.toolbox.skillTags}
              </div>
              <div className="flex flex-wrap gap-1 pl-5">
                {tags.map((tag) => (
                  <span key={tag} className="px-2 py-0.5 rounded-full bg-[var(--abu-bg-active)] text-[var(--abu-text-secondary)] text-[10px]">
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Allowed Tools */}
          {allowedTools && allowedTools.length > 0 && (
            <div className="space-y-1">
              <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--abu-text-tertiary)]">
                <Wrench className="h-3.5 w-3.5" />
                {t.toolbox.skillAllowedTools}
              </div>
              <div className="flex flex-wrap gap-1 pl-5">
                {allowedTools.map((tool) => (
                  <span key={tool} className="px-2 py-0.5 rounded bg-blue-50 text-blue-600 text-[10px] font-mono">
                    {tool}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Context mode & Max turns */}
          <div className="flex gap-4">
            {context && (
              <div className="space-y-1">
                <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--abu-text-tertiary)]">
                  <Layers className="h-3.5 w-3.5" />
                  {t.toolbox.skillContext}
                </div>
                <p className="text-xs text-[var(--abu-text-secondary)] pl-5">
                  {context === 'fork' ? t.toolbox.skillContextFork : t.toolbox.skillContextInline}
                </p>
              </div>
            )}
            {maxTurns && (
              <div className="space-y-1">
                <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--abu-text-tertiary)]">
                  <RotateCcw className="h-3.5 w-3.5" />
                  {t.toolbox.skillMaxTurns}
                </div>
                <p className="text-xs text-[var(--abu-text-secondary)] pl-5">{maxTurns}</p>
              </div>
            )}
          </div>

          {/* Content Preview */}
          {content && (
            <div className="space-y-1">
              <div className="text-xs font-medium text-[var(--abu-text-tertiary)]">{t.toolbox.skillContent}</div>
              <div className="border border-[var(--abu-border)] rounded-lg p-3 bg-[var(--abu-bg-muted)] max-h-60 overflow-y-auto">
                <MarkdownRenderer content={content} />
              </div>
            </div>
          )}

          {/* Supporting Files */}
          {supportingFiles.length > 0 && (
            <div className="space-y-1">
              <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--abu-text-tertiary)]">
                <FolderTree className="h-3.5 w-3.5" />
                {t.toolbox.skillFiles}
              </div>
              <div className="border border-[var(--abu-border)] rounded-lg p-3 bg-[var(--abu-bg-muted)]">
                <div className="text-xs text-[var(--abu-text-secondary)] font-mono space-y-0.5">
                  <div className="text-[var(--abu-text-primary)] font-medium">SKILL.md</div>
                  {supportingFiles.map((file) => (
                    <div key={file} className="pl-2 text-[var(--abu-text-secondary)]">{file}</div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[var(--abu-bg-active)]">
          {!isInstalled && onInstall && (
            <button
              onClick={onInstall}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium bg-[var(--abu-clay)] text-white hover:bg-[var(--abu-clay-hover)] transition-colors"
            >
              <Download className="h-3.5 w-3.5" />
              {t.toolbox.install}
            </button>
          )}
          {isInstalled && onEdit && (
            <button
              onClick={onEdit}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium bg-[var(--abu-text-primary)] text-[var(--abu-bg-base)] hover:bg-[var(--abu-text-primary)] transition-colors"
            >
              <Pencil className="h-3.5 w-3.5" />
              {t.toolbox.skillEdit}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
