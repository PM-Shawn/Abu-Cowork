import { memo, useCallback, useState, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
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
import { Button, IconButton } from '@/components/ds/button';
import { useConfirm } from '@/components/ds/confirm-context';
import { EmptyState } from '@/components/ds/empty-state';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { Menu, MenuItem } from '@/components/ds/menu';
import { Switch } from '@/components/ds/switch';
import { Tag } from '@/components/ds/tag';
import { remove } from '@tauri-apps/plugin-fs';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { writeFile } from '@tauri-apps/plugin-fs';
import { packSkill } from '@/core/skill/packager';
import { useToastStore } from '@/stores/toastStore';
import { getParentDir } from '@/utils/pathUtils';
import type { Skill } from '@/types';
import { sourceToUXCategory } from '@/core/skill/uxCategory';
import type { ExtensionSource } from '@/components/toolbox/extensionSource';
import { useExtensionSourceStore } from '@/stores/extensionSourceStore';
import ToolCard from '@/components/toolbox/ToolCard';
import ToolGrid from '@/components/toolbox/ToolGrid';
import SkillDetailPanel from '@/components/toolbox/skills/SkillDetailPanel';
import { usePluginSkillGate } from '@/components/toolbox/plugins/usePluginSkillGate';
import { cardOrNeighbour, cardPlace, cardProps, focusByTestId, focusIsOnWindow, type CardPlace } from '@/components/toolbox/cardFocus';
import { isUserOwnedSkill } from '@/components/toolbox/skills/isSystemSkill';
import SourceBadge from '@/components/toolbox/SourceBadge';
import { pluginOwnerForSkill } from '@/core/plugin/activationPolicy';
import { pluginDisplayName } from '@/core/plugin/installedStore';
import { usePluginStore } from '@/stores/pluginStore';

// Build a set of system skill names from marketplace templates
/**
 * Map a skill source to the label on its card (Task #22). User-scope skills
 * get no label — that's the "my skills" default and adding one there
 * would be pure noise. Only surface sources where the distinction matters:
 *   - workspace-auto  → "本项目自治" (agent-written, accepted via card)
 *   - project*        → "项目" (workspace's own .abu/skills git-tracked)
 *   - standard        → "标准" (~/.agents/skills cross-client)
 * builtin gets NO label — those cards already sit under the "市场" category
 * group, so a per-card source label there is redundant.
 */
type SourceLabelKey = 'skillSourceWorkspaceAuto' | 'skillSourceProject' | 'skillSourceStandard';
function sourceLabelKey(skill: Skill): SourceLabelKey | null {
  if (skill.source === 'workspace-auto') return 'skillSourceWorkspaceAuto';
  if (skill.source === 'project' || skill.source === 'project-standard') return 'skillSourceProject';
  if (skill.source === 'standard') return 'skillSourceStandard';
  return null;  // 'user' — default, no label
}

/**
 * Puts the focus on the skill's card; once that card has gone, on the card that took its place,
 * else the one before it, else the empty shelf's own button, else the page's 「添加」 button.
 */
function focusSkillCard(root: ParentNode | null, place: CardPlace | null): void {
  const card = root && place ? cardOrNeighbour(root, 'skill', place.id, place.index) : null;
  if (card) card.focus();
  else if (!root || !focusByTestId('skills-mine-create', root)) focusByTestId('skill-create-trigger');
}

/**
 * One card of the shelf. `memo` with stable props: a shelf holds up to a hundred cards and each
 * holds a switch, and the page renders for every window it opens and every character typed in
 * its search box.
 */
const SkillCard = memo(function SkillCard({ skill, enabled, gated, market, pluginName, onOpen, onToggle }: {
  skill: Skill;
  enabled: boolean;
  /** The plugin that owns the skill is switched off. */
  gated: boolean;
  market: boolean;
  /** The display name of the plugin that brought the skill in, when one did and it is known. */
  pluginName: string | undefined;
  onOpen: (name: string) => void;
  onToggle: (name: string) => void;
}) {
  const { t } = useI18n();
  const labelKey = sourceLabelKey(skill);
  const provenance = skill.source === 'plugin' ? <SourceBadge source={{ kind: 'plugin', plugin: pluginName }} />
    : skill.source === 'enterprise' ? <SourceBadge source={{ kind: 'enterprise' }} /> : null;
  return (
    <div className="h-full" {...cardProps('skill', skill.name)}>
      <ToolCard
        item={{
          id: skill.name,
          name: skill.name,
          description: skill.description,
          avatar: <Icon icon={AppIcons.file} size="lg" className="text-label-tertiary" />,
          badge: provenance ?? (labelKey ? <Tag>{t.toolbox[labelKey]}</Tag> : undefined),
          toggle: market ? (
            <span data-testid="skill-installed-badge" className="flex">
              <Tag>{t.toolbox.installedMark}</Tag>
            </span>
          ) : (
            <span className="flex" onClick={(event) => event.stopPropagation()} title={gated ? t.toolbox.skillPluginDisabled : undefined}>
              <Switch checked={enabled} disabled={gated} onCheckedChange={() => onToggle(skill.name)} aria-label={skill.name} />
            </span>
          ),
        }}
        onClick={() => onOpen(skill.name)}
      />
    </div>
  );
});

interface SkillsSectionProps {
  manualCreateTrigger?: number;
  /** Unified upload dialog (folder / .askill / .zip) — opened from ToolboxModal's
   *  header create-menu ("导入技能"). Controlled from outside like MCPSection's
   *  showAddForm, with an internal fallback so the component still works standalone. */
  showUploadModal?: boolean;
  onUploadModalChange?: (open: boolean) => void;
  /** Which shelf this render is showing — the sub-nav's current pick.
   *  Defaults to 市场, the shelf a fresh install has something on. */
  source?: ExtensionSource;
}

export default function SkillsSection({ manualCreateTrigger, showUploadModal: externalShowUploadModal, onUploadModalChange, source = 'market' }: SkillsSectionProps) {
  const skills = useDiscoveryStore((s) => s.skills);
  const refresh = useDiscoveryStore((s) => s.refresh);
  // We subscribe to drafts count here (not SkillDraftsPanel itself) so
  // the 阿布沉淀 category's visibility condition accounts for pending
  // drafts even when there are no workspace-auto skills yet.
  const draftsCount = useSkillDraftsStore((s) => s.drafts.length);
  const disabledSkills = useSettingsStore((s) => s.disabledSkills);
  const toggleSkillEnabled = useSettingsStore((s) => s.toggleSkillEnabled);
  const closeExtensions = useSettingsStore((s) => s.closeExtensions);
  // The 技能 tab's own remembered query (per-tab since the search box stopped
  // being cleared on every tab switch).
  const extensionsSearchQuery = useExtensionsSearchQuery('skills');
  const startNewConversation = useChatStore((s) => s.startNewConversation);
  const setPendingInput = useChatStore((s) => s.setPendingInput);
  // A skill the user just wrote or imported is on the other shelf: land them
  // where it actually is, or the create reads as a create that did nothing.
  const setSource = useExtensionSourceStore((s) => s.setSource);
  const { t } = useI18n();
  const confirm = useConfirm();
  const installedPlugins = usePluginStore((s) => s.installed);

  const installedSkills = useMemo(() => skills.flatMap((meta) => {
    const skill = skillLoader.getSkill(meta.name, { includeDisabledPlugins: true });
    return skill ? [skill] : [];
  }), [skills]);
  // The list above deliberately keeps disabled plugins' skills visible; this
  // gate stops the card from also claiming they are active (the model's
  // strict getAvailableSkills() has already dropped them).
  const pluginAllowed = usePluginSkillGate();
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null);
  const [editorSkill, setEditorSkill] = useState<Skill | 'new' | null>(null);
  // The history window of one skill. It stays on the page, closed, while it fades out.
  const [history, setHistory] = useState<{ skill: Skill; open: boolean } | null>(null);
  // Unified upload dialog (folder / .askill / .zip via click or drag-drop)
  const [internalShowUploadModal, setInternalShowUploadModal] = useState(false);
  const showUploadModal = externalShowUploadModal ?? internalShowUploadModal;
  const setShowUploadModal = (open: boolean) => {
    onUploadModalChange?.(open);
    setInternalShowUploadModal(open);
  };

  const rootRef = useRef<HTMLDivElement>(null);
  // What the handlers read: the skill whose window is open, whether one of the page's windows
  // is open, and whether the editor has taken the place of the list. The first two are set
  // further down, once the skill the window shows is known.
  const selectedRef = useRef<string | null>(null);
  const windowOpen = useRef(false);
  const editorOpen = useRef(false);
  useLayoutEffect(() => {
    editorOpen.current = editorSkill !== null;
  });

  // The card whose windows are open (detail, then history). The window that closes last may have
  // opened from a control that is gone: the focus then goes back to the card, or to what took its
  // place once it has gone.
  const opener = useRef<CardPlace | null>(null);
  const openDetail = useCallback((name: string) => {
    opener.current = cardPlace(rootRef.current, 'skill', name);
    setSelectedSkill(name);
  }, []);
  const afterWindowClosed = (event: Event) => {
    // Another layer took the focus, or one of this card's windows is still open.
    if (event.defaultPrevented || !opener.current) return;
    // The editor took the place of the list, or another window of the page is open: the focus is theirs.
    if (editorOpen.current || windowOpen.current) { event.preventDefault(); return; }
    event.preventDefault();
    focusSkillCard(rootRef.current, opener.current);
  };

  // The editor replaces the list. It takes the focus on its way back; when it is left the focus
  // returns to the control it was opened from, or to the card of the skill once that control has gone.
  const editorEntry = useRef<{ element: Element | null; place: CardPlace | null } | null>(null);
  const openEditor = (target: Skill | 'new') => {
    if (!editorOpen.current) {
      editorEntry.current = {
        element: document.activeElement,
        place: target === 'new' ? null : cardPlace(rootRef.current, 'skill', target.name),
      };
    }
    setEditorSkill(target);
  };
  const editorShown = useRef(false);
  useLayoutEffect(() => {
    const was = editorShown.current;
    editorShown.current = editorSkill !== null;
    if (!was || editorSkill !== null) return;
    const entry = editorEntry.current;
    editorEntry.current = null;
    // Only when no control has the focus: it sat on the editor, which has left.
    if (!focusIsOnWindow()) return;
    const from = entry?.element;
    if (from instanceof HTMLElement && from !== document.body && from.isConnected) from.focus();
    else focusSkillCard(rootRef.current, entry?.place ?? null);
  }, [editorSkill]);

  // Open blank editor when manual create is triggered from parent
  useEffect(() => {
    if (manualCreateTrigger && manualCreateTrigger > 0) {
      if (!editorOpen.current) editorEntry.current = { element: document.activeElement, place: null };
      setEditorSkill('new');
    }
  }, [manualCreateTrigger]);

  // Load full skill details. No auto-selection: the detail is a modal now,
  // so it stays closed until the user clicks a card.

  const disabledSet = useMemo(() => new Set(disabledSkills), [disabledSkills]);

  // Scope by source first, search second — the two answer different questions,
  // and the empty state needs them apart: nothing of the user's own at all
  // ("还没有你创建的技能") reads differently from "your skills, none matching".
  // `sourceToUXCategory` is the single authority on which shelf a skill sits
  // on (an un-tagged legacy skill counts as the user's own; an unknown source
  // is hidden rather than misfiled), so the two shelves read it rather than
  // keeping a second list of sources that can drift from it.
  const scopedSkills = useMemo(() => {
    // 市场 is the catalogue: what Abu ships (and what an organization or a
    // market offers later), each row saying whether it is installed. 我的 is
    // everything installed — the bundled skills, which ship installed, plus
    // the user's own, the plugins' and the organization's. The switch that
    // decides whether Abu may use a skill lives on the 我的 card.
    return installedSkills.filter((s) => {
      const bucket = sourceToUXCategory(s.source);
      return source === 'mine' ? bucket === 'mine' || bucket === 'builtin' : bucket === 'builtin';
    });
  }, [installedSkills, source]);

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

  // Built-ins a same-name user skill covered: still listed under 市场, marked,
  // so the user knows which copy is live instead of thinking one vanished.
  const shadowedBuiltin = useMemo(() => {
    // A 「我的」 render has no 市场 group to belong to: scoping here keeps
    // shadowed built-ins from resurrecting that group on their own.
    if (source === 'mine') return [];
    const q = searchLower;
    // Whatever covered the built-in — a user's own file, a plugin's, the
    // organization's — sits under 「我的」, which is where the hint points.
    return skillLoader.getShadowedSkills().filter((s) => {
      if (s.source !== 'builtin') return false;
      return !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q);
    });
  }, [skills, searchLower, source]); // eslint-disable-line react-hooks/exhaustive-deps

  const selected = installedSkills.find((s) => s.name === selectedSkill) ?? null;
  // The detail window keeps showing the skill it held while it fades out.
  const [held, setHeld] = useState<Skill | null>(null);
  if (selected && selected !== held) setHeld(selected);
  const shown = selected ?? held;
  // The window is open while the chosen skill is on the list: once the skill has left it, the
  // window fades out although the choice still names it.
  useLayoutEffect(() => {
    selectedRef.current = selected ? selected.name : null;
    windowOpen.current = selected !== null || history?.open === true;
  });

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

  // The skill a delete is removing, and where its card sat: once it has gone the focus goes to
  // the card that took its place, else the one before it, else the page's 「添加」 button.
  const leaving = useRef<CardPlace | null>(null);
  const deleting = useRef(false);
  useLayoutEffect(() => {
    const gone = leaving.current;
    if (!gone || installedSkills.some((s) => s.name === gone.id)) return;
    leaving.current = null;
    opener.current = gone;
    if (!windowOpen.current && focusIsOnWindow()) focusSkillCard(rootRef.current, gone);
  }, [installedSkills]);

  // Deleting removes the skill's folder for good, so it is asked first, naming the skill. The
  // question is asked over the open window, which answers it "no" when it goes. The answer acts
  // on the skill as it is at that moment: nothing is removed when the window shows another
  // skill, or when the name no longer leads to the same file.
  const askToDelete = async (skill: Skill) => {
    // The window stays on the page while it fades out; a key press there asks nothing.
    if (selectedRef.current !== skill.name || deleting.current) return;
    const confirmed = await confirm({
      title: t.toolbox.deleteItem,
      message: skill.name,
      confirmLabel: t.common.delete,
      tone: 'danger',
    });
    if (!confirmed || selectedRef.current !== skill.name || deleting.current) return;
    const current = skillLoader.getSkill(skill.name);
    if (!current || current.filePath !== skill.filePath) return;
    deleting.current = true;
    leaving.current = cardPlace(rootRef.current, 'skill', skill.name);
    try {
      await handleDelete(skill);
    } finally {
      deleting.current = false;
      // The delete failed and the skill is still there: its card keeps its place.
      if (skillLoader.getSkill(skill.name)) leaving.current = null;
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

  // One window at a time: the history window takes the place of the detail window.
  const openHistory = (skill: Skill) => {
    setHistory({ skill, open: true });
    setSelectedSkill(null);
  };

  // The detail window's 「…」 menu. An entry that opens something which takes the focus runs once
  // the menu has gone; opening the menu forgets a choice its close hook never ran for.
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const pendingMenuAction = useRef<(() => void) | null>(null);

  const renderSkillCard = (skill: Skill) => {
    const gated = !pluginAllowed(skill);
    // Plugin and organization skills sit under 「我的」 with their provenance
    // on the card, the same label the expert and team cards carry.
    const owner = skill.source === 'plugin' ? pluginOwnerForSkill(skill.skillDir) : undefined;
    return (
      <SkillCard
        key={skill.name}
        skill={skill}
        enabled={!disabledSet.has(skill.name) && !gated}
        gated={gated}
        // On 市场 a card says whether the skill is installed; the switch belongs to
        // 我的, where the user's installed skills are.
        market={source !== 'mine'}
        pluginName={owner ? pluginDisplayName(installedPlugins, owner) : undefined}
        onOpen={openDetail}
        onToggle={toggleSkillEnabled}
      />
    );
  };

  const renderShadowedCard = (skill: Skill) => (
    <ToolCard
      key={`shadowed:${skill.name}`}
      item={{
        id: `shadowed:${skill.name}`,
        name: skill.name,
        description: skill.description,
        avatar: <Icon icon={AppIcons.file} size="lg" className="text-label-tertiary" />,
        badge: (
          <span className="flex" title={t.toolbox.skillShadowedHint}>
            <Tag>{t.toolbox.skillShadowedBadge}</Tag>
          </span>
        ),
        toggle: (
          <span className="flex" title={t.toolbox.skillShadowedHint}>
            <Switch checked={false} disabled onCheckedChange={() => {}} aria-label={skill.name} />
          </span>
        ),
        testId: `skill-shadowed-${skill.name}`,
      }}
    />
  );

  // If editor is open, show editor full-width
  if (editorSkill !== null) {
    return (
      <SkillEditor
        skill={editorSkill === 'new' ? null : editorSkill}
        onClose={() => setEditorSkill(null)}
        onSave={async () => { await refresh(); setEditorSkill(null); setSource('skills', 'mine'); }}
      />
    );
  }

  // Drafts belong to 「我的」 (Abu wrote them for this user); 「市场」 never shows
  // them, so only 「我的」 lets a pending draft hold off the empty state.
  const draftsVisible = source === 'mine' && draftsCount > 0;

  return (
    <div ref={rootRef} className="flex h-full flex-col overflow-hidden">
      {/* Category blocks manager (Task #45 · reject-category undo) —
          hidden when the workspace has no blocks. Kept at the top
          because it's a global "management" surface (not tied to any
          one skill), and doesn't belong inside the 阿布沉淀 category. */}
      <SkillCategoryBlocksPanel />

      {/* Card grid — horizontally inset to match the header row above (ToolboxModal's
          TopTabNav), with a centered max-width so cards don't stretch edge-to-edge. */}
      <div className="flex-1 overflow-y-scroll overlay-scroll px-8 pt-3 pb-6">
        {/* Drafts are not skills on disk yet, so they are absent from
            filteredSkills — they come from the drafts store, under 「我的」 only.
            Falling into the empty state while drafts are pending would hide
            them behind 「还没有你创建的技能」, and nothing else would surface them. */}
        {filteredSkills.length === 0 && shadowedBuiltin.length === 0 && !draftsVisible ? (
          <div className="py-8">
            {source === 'mine' && scopedSkills.length === 0 ? (
              <EmptyState
                icon={AppIcons.file}
                title={t.toolbox.skillsMineEmptyTitle}
                description={t.toolbox.skillsMineEmptyHint}
                action={<Button variant="secondary" data-testid="skills-mine-create" onClick={() => openEditor('new')}>{t.toolbox.createSkill}</Button>}
              />
            ) : (
              <EmptyState icon={AppIcons.file} title={t.toolbox.noSkillsFound} />
            )}
          </div>
        ) : (
          <div className="max-w-5xl mx-auto space-y-6">
            {/* One shelf at a time — which one is the sub-nav's job to say, so
                the group heading that used to name it here is gone.
                「我的」: what this user has — their own files, what installed
                plugins brought in, what the organization pushed.
                「市场」: bundled skills, plus the built-in a same-name skill
                of theirs covers. */}
            {(filteredSkills.length > 0 || shadowedBuiltin.length > 0) && (
              <ToolGrid>
                {filteredSkills.map((skill) => renderSkillCard(skill))}
                {shadowedBuiltin.map((skill) => renderShadowedCard(skill))}
              </ToolGrid>
            )}

            {/* 阿布沉淀 — pending drafts awaiting user review. workspace-auto
                skills (accepted) sit in the grid above with a per-card
                "自进化" label. SkillDraftsPanel is its own list UI (not a card
                grid) — kept as-is rather than reshaped into ToolCards. */}
            {draftsVisible && (
              <div>
                <div className="mb-3 flex items-center gap-2 pl-3 text-ui font-medium text-label-tertiary">
                  <span>{t.toolbox.categoryAgentEvolved}</span>
                  <Tag>{t.toolbox.categoryAgentEvolvedBadge}</Tag>
                  <span className="text-caption font-normal">{draftsCount}</span>
                </div>
                <SkillDraftsPanel />
              </div>
            )}
          </div>
        )}
      </div>

      {/* Released detail actions remain available from every skill card. */}
      <SkillDetailPanel
        skill={selected}
        onClose={() => setSelectedSkill(null)}
        onCloseAutoFocus={afterWindowClosed}
        headerActions={shown ? (
          <>
            <Switch
              checked={!disabledSet.has(shown.name)}
              onCheckedChange={() => toggleSkillEnabled(shown.name)}
              aria-label={shown.name}
            />
            {/* "..." menu: export and history for every skill; the user's own skills also have edit */}
            <Menu
              align="end"
              onOpenChange={(open) => { if (open) pendingMenuAction.current = null; }}
              onCloseAutoFocus={(event) => {
                const pending = pendingMenuAction.current;
                pendingMenuAction.current = null;
                if (!pending) return;
                event.preventDefault();
                menuTrigger.current?.focus();
                pending();
              }}
              trigger={(
                <IconButton
                  ref={menuTrigger}
                  icon={AppIcons.more}
                  label={format(t.toolbox.itemMenuLabel, { name: shown.name })}
                  data-testid="skill-detail-menu"
                />
              )}
            >
              {/* Export - available for all skills. The window stays on the page while it fades out; a choice made there does nothing. */}
              <MenuItem icon={AppIcons.download} onSelect={() => { if (selectedRef.current === shown.name) void handleExport(shown); }}>
                {t.toolbox.exportSkill}
              </MenuItem>
              {/* History (Task #24) — available for all skills;
                  builtin skills typically have no history, so
                  the window's empty state explains this. */}
              <MenuItem
                icon={AppIcons.history}
                onSelect={() => { pendingMenuAction.current = () => { if (selectedRef.current === shown.name) openHistory(shown); }; }}
              >
                {t.toolbox.historyMenuLabel}
              </MenuItem>
              {/* Edit - available for non-builtin skills */}
              {isUserOwnedSkill(shown) && (
                <MenuItem
                  icon={AppIcons.rename}
                  onSelect={() => {
                    pendingMenuAction.current = () => {
                      if (selectedRef.current !== shown.name) return;
                      openEditor(shown);
                      setSelectedSkill(null);
                    };
                  }}
                >
                  {t.toolbox.skillEdit}
                </MenuItem>
              )}
            </Menu>
          </>
        ) : undefined}
        footer={shown ? <div className="flex w-full items-center justify-between gap-3">
          {isUserOwnedSkill(shown) ? (
            <Button variant="danger" size="sm" icon={AppIcons.delete} onClick={() => { void askToDelete(shown); }}>{t.toolbox.deleteItem}</Button>
          ) : !pluginAllowed(shown) ? (
            <span className="text-caption text-label-tertiary">{t.toolbox.skillPluginDisabled}</span>
          ) : shown.source === 'plugin' ? (
            // Under 「我的」 without a delete button: say where it came from and
            // how it leaves, the way the expert detail does.
            <span className="text-caption text-label-tertiary" data-testid="skill-plugin-origin">
              {format(t.toolbox.itemFromPluginRemoveHint, { plugin: pluginDisplayName(installedPlugins, pluginOwnerForSkill(shown.skillDir) ?? '') })}
            </span>
          ) : <span />}

          <Button variant="primary" size="sm" icon={AppIcons.startChat} disabled={disabledSet.has(shown.name) || !pluginAllowed(shown)} onClick={() => {
            // The window stays on the page while it fades out; a key press there starts nothing.
            if (selectedRef.current !== shown.name) return;
            startNewConversation();
            setPendingInput(`/${shown.name} `, { startsTask: true });
            setSelectedSkill(null);
            closeExtensions();
          }}>{t.toolbox.menuTrial}</Button>
        </div> : undefined}
      />

      {/* Unified upload window. Its drop zone listens for dropped files only while the window is on the page. */}
      <SkillUploadModal
        open={showUploadModal}
        onClose={() => setShowUploadModal(false)}
        onInstalled={(name) => { setSource('skills', 'mine'); openDetail(name); }}
        // The imported skill's window opens as this one closes: the focus is that window's.
        onCloseAutoFocus={(event) => { if (windowOpen.current) event.preventDefault(); }}
      />

      {/* Skill history window (Task #24) — mounted from the moment it is opened until it has gone. */}
      {history && (
        <SkillHistoryModal
          key={history.skill.skillDir}
          open={history.open}
          readOnly={history.skill.source === 'plugin' || history.skill.source === 'enterprise'}
          skillDir={history.skill.skillDir}
          skillName={history.skill.name}
          onClose={() => setHistory((current) => (current ? { ...current, open: false } : current))}
          onCloseAutoFocus={(event) => {
            setHistory((current) => (current && !current.open ? null : current));
            afterWindowClosed(event);
          }}
        />
      )}
    </div>
  );
}
