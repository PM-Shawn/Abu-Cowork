import { useState, useEffect, useMemo } from 'react';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { useSkillDraftsStore } from '@/stores/skillDraftsStore';
import { useExtensionsSearchQuery, useSettingsStore } from '@/stores/settingsStore';
import { useChatStore } from '@/stores/chatStore';
import { format, useI18n } from '@/i18n';
import { skillLoader } from '@/core/skill/loader';
import SkillEditor from './SkillEditor';
import SkillDraftsPanel from './SkillDraftsPanel';
import SkillCategoryBlocksPanel from './SkillCategoryBlocksPanel';
import SkillHistoryModal from './SkillHistoryModal';
import SkillUploadModal from './SkillUploadModal';
import { Button } from '@/components/ui/button';
import { Toggle } from '@/components/ui/toggle';
import { FileText, Pencil, MoreHorizontal, MessageCircle, Download, Clock } from 'lucide-react';
import { remove } from '@tauri-apps/plugin-fs';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { writeFile } from '@tauri-apps/plugin-fs';
import { packSkill } from '@/core/skill/packager';
import { useToastStore } from '@/stores/toastStore';
import { getParentDir } from '@/utils/pathUtils';
import type { Skill, SkillSource, SkillUXCategory } from '@/types';
import { sourceToUXCategory } from '@/core/skill/uxCategory';
import ToolCard from '@/components/toolbox/ToolCard';
import ToolGrid from '@/components/toolbox/ToolGrid';
import SkillDetailPanel from '@/components/toolbox/skills/SkillDetailPanel';

// Build a set of system skill names from marketplace templates
/**
 * Map a skill source to its visual badge (Task #22). User-scope skills
 * get no badge — that's the "my skills" default and adding a pill there
 * would be pure noise. Only surface sources where the distinction matters:
 *   - workspace-auto  → "本项目自治" (agent-written, accepted via card)
 *   - project*        → "项目" (workspace's own .abu/skills git-tracked)
 *   - standard        → "标准" (~/.agents/skills cross-client)
 * builtin gets NO badge — those cards already sit under the "市场" category
 * group, so a per-card source pill there is redundant.
 */
type SourceBadge = { labelKey: 'skillSourceWorkspaceAuto' | 'skillSourceProject' | 'skillSourceStandard'; tone: 'clay' | 'blue' | 'slate' } | null;
function sourceBadge(skill: Skill): SourceBadge {
  if (skill.source === 'workspace-auto') return { labelKey: 'skillSourceWorkspaceAuto', tone: 'clay' };
  if (skill.source === 'project' || skill.source === 'project-standard') return { labelKey: 'skillSourceProject', tone: 'blue' };
  if (skill.source === 'standard') return { labelKey: 'skillSourceStandard', tone: 'slate' };
  return null;  // 'user' — default, no badge
}

const SOURCE_BADGE_TONE: Record<'neutral' | 'clay' | 'blue' | 'slate', string> = {
  neutral: 'bg-[var(--abu-bg-muted)] text-[var(--abu-text-muted)]',
  clay: 'bg-[var(--abu-clay-tint)] text-[var(--abu-clay)]',
  blue: 'bg-[var(--abu-info-bg)] text-[var(--abu-info)]',
  slate: 'bg-slate-100 dark:bg-[var(--abu-bg-muted)] text-slate-600 dark:text-[var(--abu-text-secondary)]',
};

/** Optional authored-only filtering for embedded callers; the released page shows every source. */
const MINE_SOURCES: ReadonlySet<SkillSource> = new Set<SkillSource>([
  'user', 'workspace-auto', 'draft', 'project', 'project-standard', 'standard',
]);

interface SkillsSectionProps {
  manualCreateTrigger?: number;
  /** Unified upload dialog (folder / .askill / .zip) — opened from ToolboxModal's
   *  header create-menu ("导入技能"). Controlled from outside like MCPSection's
   *  showAddForm, with an internal fallback so the component still works standalone. */
  showUploadModal?: boolean;
  onUploadModalChange?: (open: boolean) => void;
  /** Optional authored-only view. Omit to retain the released grouped page. */
  sourceFilter?: 'mine';
}

export default function SkillsSection({ manualCreateTrigger, showUploadModal: externalShowUploadModal, onUploadModalChange, sourceFilter }: SkillsSectionProps) {
  const { skills, refresh } = useDiscoveryStore();
  // We subscribe to drafts count here (not SkillDraftsPanel itself) so
  // the 阿布沉淀 category's visibility condition accounts for pending
  // drafts even when there are no workspace-auto skills yet.
  const draftsCount = useSkillDraftsStore((s) => s.drafts.length);
  const { disabledSkills, toggleSkillEnabled, closeExtensions } = useSettingsStore();
  // The 技能 tab's own remembered query (per-tab since the search box stopped
  // being cleared on every tab switch).
  const extensionsSearchQuery = useExtensionsSearchQuery('skills');
  const startNewConversation = useChatStore((s) => s.startNewConversation);
  const setPendingInput = useChatStore((s) => s.setPendingInput);
  const { t } = useI18n();

  const installedSkills = useMemo(() => skills.flatMap((meta) => {
    const skill = skillLoader.getSkill(meta.name, { includeDisabledPlugins: true });
    return skill ? [skill] : [];
  }), [skills]);
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null);
  const [editorSkill, setEditorSkill] = useState<Skill | 'new' | null>(null);
  const [menuSkill, setMenuSkill] = useState<string | null>(null);
  const [historySkill, setHistorySkill] = useState<Skill | null>(null);
  // Unified upload dialog (folder / .askill / .zip via click or drag-drop)
  const [internalShowUploadModal, setInternalShowUploadModal] = useState(false);
  const showUploadModal = externalShowUploadModal ?? internalShowUploadModal;
  const setShowUploadModal = (open: boolean) => {
    onUploadModalChange?.(open);
    setInternalShowUploadModal(open);
  };

  // Open blank editor when manual create is triggered from parent
  useEffect(() => {
    if (manualCreateTrigger && manualCreateTrigger > 0) {
      setEditorSkill('new');
    }
  }, [manualCreateTrigger]);

  // Load full skill details. No auto-selection: the detail is a modal now,
  // so it stays closed until the user clicks a card.

  const disabledSet = useMemo(() => new Set(disabledSkills), [disabledSkills]);

  // Scope by source first, search second — the two answer different questions,
  // and the empty state needs them apart: nothing of the user's own at all
  // ("还没有你创建的技能") reads differently from "your skills, none matching".
  const scopedSkills = useMemo(() => {
    if (sourceFilter !== 'mine') return installedSkills;
    // An un-tagged legacy skill counts as the user's own, matching
    // sourceToUXCategory()'s treatment of `undefined`.
    return installedSkills.filter((s) => s.source === undefined || MINE_SOURCES.has(s.source));
  }, [installedSkills, sourceFilter]);

  // Filter by search
  const searchLower = extensionsSearchQuery.toLowerCase();
  const filteredSkills = useMemo(() => {
    if (!searchLower) return scopedSkills;
    return scopedSkills.filter((s) => {
      const tagStr = (s.tags ?? []).join(' ').toLowerCase();
      return s.name.toLowerCase().includes(searchLower) ||
        s.description.toLowerCase().includes(searchLower) ||
        tagStr.includes(searchLower);
    });
  }, [scopedSkills, searchLower]);

  // Group skills by source for display
  // Group skills by UX category — 4 top-level buckets that match the
  // user's mental model (mine / agent-evolved / third-party / builtin)
  // rather than the raw on-disk source enum. See uxCategory.ts for
  // the mapping; unknown sources are dropped with a console.warn so
  // they don't silently land in "mine" (pre-refactor bug where
  // workspace-auto skills looked like user-created ones).
  const skillGroups = useMemo(() => {
    const groups: Record<SkillUXCategory, Skill[]> = {
      mine: [],
      'agent-evolved': [],
      builtin: [],
    };
    for (const s of filteredSkills) {
      const cat = sourceToUXCategory(s.source);
      if (cat) groups[cat].push(s);
    }
    return groups;
  }, [filteredSkills]);

  const selected = installedSkills.find((s) => s.name === selectedSkill) ?? null;

  // Delete a user-installed skill. With the detail now a modal (not a
  // list panel), there's no natural "adjacent" item to select after
  // deletion — mirror AgentsSection and just close the modal.
  const handleDelete = async (skill: Skill) => {
    if (skill.filePath.includes('builtin-skills')) return;
    try {
      const skillDir = getParentDir(skill.filePath);
      await remove(skillDir, { recursive: true });
      if (selectedSkill === skill.name) setSelectedSkill(null);
      await refresh();
    } catch (err) {
      console.error('Failed to delete skill:', err);
    }
  };

  // Export a skill as .askill package
  const handleExport = async (skill: Skill) => {
    const addToast = useToastStore.getState().addToast;
    try {
      const filePath = await saveDialog({
        defaultPath: `${skill.name}.askill`,
        filters: [{ name: 'Skill Package', extensions: ['askill'] }],
      });
      if (!filePath) return;

      const bytes = await packSkill(skill.skillDir);
      await writeFile(filePath, bytes);
      addToast({ type: 'success', title: t.toolbox.exportSuccess, message: `"${skill.name}"` });
    } catch (err) {
      console.error('Export skill failed:', err);
      addToast({ type: 'error', title: t.toolbox.exportFailed, message: String(err) });
    }
  };

  // Close the "..." menu when clicking outside
  useEffect(() => {
    if (!menuSkill) return;
    const handleClick = () => setMenuSkill(null);
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [menuSkill]);

  const renderSkillCard = (skill: Skill) => {
    const isEnabled = !disabledSet.has(skill.name);
    const badge = sourceBadge(skill);
    return (
      <ToolCard
        key={skill.name}
        item={{
          id: skill.name,
          name: skill.name,
          description: skill.description,
          avatar: <FileText className="h-6 w-6 text-[var(--abu-text-muted)]" />,
          badge: badge ? (
            <span className={`shrink-0 px-1.5 py-0.5 rounded text-caption font-medium ${SOURCE_BADGE_TONE[badge.tone]}`}>
              {t.toolbox[badge.labelKey]}
            </span>
          ) : undefined,
          toggle: (
            <span onClick={(event) => event.stopPropagation()}>
              <Toggle checked={isEnabled} onChange={() => toggleSkillEnabled(skill.name)} size="sm" tone="green" />
            </span>
          ),
        }}
        onClick={() => setSelectedSkill(skill.name)}
      />
    );
  };

  // If editor is open, show editor full-width
  if (editorSkill !== null) {
    return (
      <SkillEditor
        skill={editorSkill === 'new' ? null : editorSkill}
        onClose={() => setEditorSkill(null)}
        onSave={async () => { await refresh(); setEditorSkill(null); }}
      />
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden bg-[var(--abu-bg-base)]">
      {/* Category blocks manager (Task #45 · reject-category undo) —
          hidden when the workspace has no blocks. Kept at the top
          because it's a global "management" surface (not tied to any
          one skill), and doesn't belong inside the 阿布沉淀 category. */}
      <SkillCategoryBlocksPanel />

      {/* Card grid — horizontally inset to match the header row above (ToolboxModal's
          TopTabNav), with a centered max-width so cards don't stretch edge-to-edge. */}
      <div className="flex-1 overflow-y-scroll overlay-scroll px-8 pb-6">
        {/* Drafts are not skills on disk yet, so they are absent from
            filteredSkills — but 阿布沉淀 is rendered from the grid branch below.
            Falling into the empty state while drafts are pending would hide
            them behind 「还没有你创建的技能」, and 「市场」 never shows drafts
            (`draft` ∈ MINE_SOURCES), so nothing else would surface them. */}
        {filteredSkills.length === 0 && draftsCount === 0 ? (
          sourceFilter === 'mine' && scopedSkills.length === 0 ? (
            <div className="py-16 text-center">
              <p className="text-h-sm text-[var(--abu-text-primary)]">{t.toolbox.skillsMineEmptyTitle}</p>
            </div>
          ) : (
            <div className="text-body text-[var(--abu-text-muted)] py-16 text-center">{t.toolbox.noSkillsFound}</div>
          )
        ) : (
          <div className="max-w-5xl mx-auto space-y-6">
            {/* Category · Mine — user's own or team-shipped skills.
                Groups user/standard/project/project-standard into one
                bucket matching the user's mental model ("I or my
                team put this on disk"), instead of splitting by the
                implementation-level SkillSource enum. */}
            {skillGroups.mine.length > 0 && (
              <div>
                <div className="mb-3 pl-3 text-body font-medium text-[var(--abu-text-muted)]">{t.toolbox.categoryMine}</div>
                <ToolGrid>{skillGroups.mine.map((skill) => renderSkillCard(skill))}</ToolGrid>
              </div>
            )}

            {/* Category · Agent-evolved — pending drafts awaiting
                user review. workspace-auto skills (accepted) now
                live in "mine" with a per-card "自进化" badge.
                Section only appears when there are active drafts.
                SkillDraftsPanel is its own list UI (not a card grid) —
                kept as-is rather than reshaped into ToolCards. */}
            {draftsCount > 0 && (
              <div>
                <div className="mb-3 pl-3 flex items-center gap-1.5 text-body font-medium text-[var(--abu-text-muted)]">
                  <span>{t.toolbox.categoryAgentEvolved}</span>
                  <span className="px-1.5 py-0.5 text-caption rounded bg-purple-100 text-purple-700">{t.toolbox.categoryAgentEvolvedBadge}</span>
                  <span className="text-caption text-[var(--abu-text-placeholder)]">{draftsCount}</span>
                </div>
                <SkillDraftsPanel />
              </div>
            )}

            {/* Category · Built-in — bundled with Abu. Read-only. */}
            {skillGroups.builtin.length > 0 && (
              <div>
                <div className="mb-3 pl-3 text-body font-medium text-[var(--abu-text-muted)]">{t.toolbox.categoryBuiltin}</div>
                <ToolGrid>{skillGroups.builtin.map((skill) => renderSkillCard(skill))}</ToolGrid>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Released detail actions remain available from every skill card. */}
      <SkillDetailPanel
        skill={selected}
        onClose={() => { setSelectedSkill(null); setMenuSkill(null); }}
        disableEscape={!!historySkill}
        headerActions={selected ? (
          <>
            <Toggle
              checked={!disabledSet.has(selected.name)}
              onChange={() => toggleSkillEnabled(selected.name)}
              tone="green"
            />
            {/* "..." menu: export always available; user skills also have edit/delete */}
            <div className="relative">
              <button
                aria-label={format(t.toolbox.itemMenuLabel, { name: selected.name })}
                data-testid="skill-detail-menu"
                onClick={(e) => { e.stopPropagation(); setMenuSkill(menuSkill === selected.name ? null : selected.name); }}
                className="p-1.5 rounded-lg text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-muted)] transition-colors"
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>
              {menuSkill === selected.name && (
                <div className="absolute right-0 top-full mt-2 z-10 bg-[var(--abu-bg-base)] border border-[var(--abu-border)] rounded-lg shadow-lg py-1 min-w-[140px]">
                  {/* Export - available for all skills */}
                  <button
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-minor text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-muted)] transition-colors"
                    onClick={() => { handleExport(selected); setMenuSkill(null); }}
                  >
                    <Download className="h-3 w-3" />
                    {t.toolbox.exportSkill}
                  </button>
                  {/* History (Task #24) — available for all skills;
                      builtin skills typically have no history, so
                      the modal's empty state explains this. */}
                  <button
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-minor text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-muted)] transition-colors"
                    onClick={() => { setHistorySkill(selected); setMenuSkill(null); }}
                  >
                    <Clock className="h-3 w-3" />
                    {t.toolbox.historyMenuLabel}
                  </button>
                  {/* Edit & Delete - available for non-builtin skills */}
                  {selected.source !== 'builtin' && selected.source !== 'plugin' && selected.source !== 'enterprise' && !selected.filePath.includes('builtin-skills') && (
                    <>
                      <button
                        className="w-full flex items-center gap-2 px-3 py-1.5 text-minor text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-muted)] transition-colors"
                        onClick={() => { setEditorSkill(selected); setMenuSkill(null); setSelectedSkill(null); }}
                      >
                        <Pencil className="h-3 w-3" />
                        {t.toolbox.skillEdit}
                      </button>

                    </>
                  )}
                </div>
              )}
            </div>


          </>
        ) : undefined}
        footer={selected ? <div className="flex items-center justify-between gap-3">
          {selected.source !== 'builtin' && selected.source !== 'plugin' && selected.source !== 'enterprise' && !selected.filePath.includes('builtin-skills') ? (
            <Button variant="ghost" size="sm" className="bg-[var(--abu-danger-bg)] text-[var(--abu-danger)] hover:bg-[var(--abu-danger-bg)] hover:text-[var(--abu-danger)] rounded-xl" onClick={() => handleDelete(selected)}>{t.toolbox.uninstall}</Button>
          ) : <span />}


          <Button size="sm" className="rounded-xl" disabled={disabledSet.has(selected.name)} onClick={() => {
            startNewConversation();
            setPendingInput(`/${selected.name} `);
            setSelectedSkill(null);
            closeExtensions();
          }}><MessageCircle className="h-3.5 w-3.5" />{t.toolbox.menuTrial}</Button>
        </div> : undefined}
      />

      {/* Unified upload modal — conditionally mounted so useFileDragDrop's
          window-level Tauri listener only runs while the modal is open. */}
      {showUploadModal && (
        <SkillUploadModal
          onClose={() => setShowUploadModal(false)}
          onInstalled={(name) => setSelectedSkill(name)}
        />
      )}

      {/* Skill history modal (Task #24) — mounted only when opened. */}
      {historySkill && (
        <SkillHistoryModal
          readOnly={historySkill.source === 'plugin' || historySkill.source === 'enterprise'}
          skillDir={historySkill.skillDir}
          skillName={historySkill.name}
          onClose={() => setHistorySkill(null)}
        />
      )}
    </div>
  );
}
