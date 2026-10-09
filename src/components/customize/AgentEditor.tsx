import { useId, useState } from 'react';
import { Button } from '@/components/ds/button';
import { Dialog, DialogClose } from '@/components/ds/dialog';
import { AppIcons } from '@/components/ds/icons';
import { InlineMessage } from '@/components/ds/inline-message';
import { Pressable } from '@/components/ds/pressable';
import { Select } from '@/components/ds/select';
import { StatusIcon } from '@/components/ds/status-icon';
import { Switch } from '@/components/ds/switch';
import { TextArea } from '@/components/ds/text-area';
import { TextField } from '@/components/ds/text-field';
import { useI18n, format } from '@/i18n';
import { serializeAgentMd, agentRegistry, getBuiltinAgentNames } from '@/core/agent/registry';
import { getAllTools } from '@/core/tools/registry';
import type { SubagentDefinition, SubagentMetadata } from '@/types';
import { useSettingsStore, getActiveProvider } from '@/stores/settingsStore';
import { navigateToChatWithInput } from '@/utils/navigation';
import { useItemName, isItemNameTaken } from '@/hooks/useItemName';
import { saveItemToAbuDir, ITEM_EXISTS_CODE, ITEM_NAME_INVALID_CODE } from '@/utils/itemStorage';
import { cn } from '@/lib/utils';
import { getUnmatchedAgentToolPatterns } from '@/utils/agentToolPresentation';
import { isPluginOwnedAgent } from '@/utils/agentSource';
import MarkdownRenderer from '@/components/chat/MarkdownRenderer';
import AvatarPicker from '@/components/common/AvatarPicker';
import AgentAvatar from '@/components/common/AgentAvatar';

/**
 * Every name an agent already answers to — builtins, the user's own, and
 * plugin agents including those of disabled plugins (their files are still on
 * disk). Saving a new or renamed agent under one of these would overwrite that
 * agent's AGENT.md, or shadow a builtin every `builtin:<name>` team points at.
 */
function agentNamesInUse(): string[] {
  return [
    ...getBuiltinAgentNames(),
    ...agentRegistry.getAvailableAgents({ includeDisabledPlugins: true }).map((a) => a.name),
  ];
}

interface AgentEditorProps {
  agent: SubagentDefinition | null;  // null = creating new agent
  onClose: () => void;
  onSave: () => Promise<void>;
  /** Whether the window is on the page. Left out, it is open for as long as the editor is mounted. */
  open?: boolean;
  /** Runs once the window has gone; `event.preventDefault()` there keeps the focus from returning to the control that opened it. */
  onCloseAutoFocus?: (event: Event) => void;
}

/** What the form holds when it opens. The window asks before closing once a field differs from it. */
interface Fields {
  name: string;
  description: string;
  avatar: string;
  model: string;
  maxTurns: string;
  toolsStr: string;
  disallowedToolsStr: string;
  skillsStr: string;
  memory: 'session' | 'project' | 'user';
  background: boolean;
  intro: string;
  expertiseStr: string;
  samplePromptsStr: string;
  category: string;
  tagsStr: string;
  systemPrompt: string;
}

function fieldsOf(agent: SubagentDefinition | null): Fields {
  // A model the current provider does not offer shows as "follow the global setting": that is
  // what it falls back to when the expert runs.
  const providerModels = getActiveProvider(useSettingsStore.getState())?.models ?? [];
  const model = agent?.model && agent.model !== 'inherit' && providerModels.some((m) => m.id === agent.model) ? agent.model : '';
  return {
    name: agent?.name ?? '',
    description: agent?.description ?? '',
    avatar: agent?.avatar ?? '',
    model,
    maxTurns: agent?.maxTurns?.toString() ?? '',
    toolsStr: (agent?.tools ?? []).join(', '),
    disallowedToolsStr: (agent?.disallowedTools ?? []).join(', '),
    skillsStr: (agent?.skills ?? []).join(', '),
    memory: agent?.memory ?? 'session',
    background: agent?.background ?? false,
    // Display-only fields rendered in the detail window and the chat welcome.
    // All optional; users can leave them blank and the agent still works.
    intro: agent?.intro ?? '',
    expertiseStr: (agent?.expertise ?? []).join('\n'),
    samplePromptsStr: (agent?.samplePrompts ?? []).join('\n'),
    category: agent?.category ?? '',
    tagsStr: (agent?.tags ?? []).join(', '),
    systemPrompt: agent?.systemPrompt ?? '',
  };
}

// The select's value for "follow the global setting": the word AGENT.md itself uses, so no model id can collide with it.
const INHERIT_MODEL = 'inherit';

const FIELD_LABEL = 'mb-1 block text-ui-sm font-medium text-label-secondary';
const GROUP_TITLE = 'text-ui-sm font-medium text-label-tertiary';
const HINT = 'mt-1 text-caption text-label-tertiary';
const REFUSED = 'mt-1 flex items-center gap-1 text-caption text-danger';

/**
 * The window that creates an expert or edits one. It asks before it discards what was typed,
 * and a save started from it runs once. The editor is mounted anew for each opening, so what
 * the fields hold when it mounts is what the expert held.
 */
export default function AgentEditor({ agent, onClose, onSave, open = true, onCloseAutoFocus }: AgentEditorProps) {
  const { t } = useI18n();
  const id = useId();
  const [saving, setSaving] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [initial] = useState(() => fieldsOf(agent));

  // Name validation via shared hook. `mode: 'agent'` keeps unicode and letter
  // case, the rule `save_agent` and the built-in experts use — without it the
  // editor falls back to the skill slug rule and cannot spell 数据分析师.
  const { name, setName, nameValid, nameTaken, nameChanged } = useItemName(agent?.name ?? null, {
    mode: 'agent',
    takenNames: agentNamesInUse(),
  });
  // The name the disk refused at save time (a file appeared after the registry
  // snapshot): shown with the same hint as a registry collision.
  const [refusedName, setRefusedName] = useState<string | null>(null);
  const nameConflict = nameValid && (nameTaken || refusedName === name.trim());
  // The name the disk refused as not one plain folder name. The format check
  // blocks such names first, but an unchanged name is never re-checked — a
  // hand-edited frontmatter `name:` reaches the save as it is.
  const [invalidName, setInvalidName] = useState<string | null>(null);
  const nameRefusedAsInvalid = invalidName === name.trim();
  // Any other save failure: shown above the buttons, cleared on retry.
  const [saveFailed, setSaveFailed] = useState(false);
  const [description, setDescription] = useState(initial.description);
  const [avatar, setAvatar] = useState(initial.avatar);
  const [model, setModel] = useState(initial.model);
  const [maxTurns, setMaxTurns] = useState(initial.maxTurns);
  const [toolsStr, setToolsStr] = useState(initial.toolsStr);
  const [disallowedToolsStr, setDisallowedToolsStr] = useState(initial.disallowedToolsStr);
  const [skillsStr, setSkillsStr] = useState(initial.skillsStr);
  const [memory, setMemory] = useState(initial.memory);
  const [background, setBackground] = useState(initial.background);
  const knownToolNames = getAllTools().map((tool) => tool.name);
  const unmatchedTools = getUnmatchedAgentToolPatterns(toolsStr, knownToolNames);
  const unmatchedDisallowedTools = getUnmatchedAgentToolPatterns(disallowedToolsStr, knownToolNames);

  const [intro, setIntro] = useState(initial.intro);
  const [expertiseStr, setExpertiseStr] = useState(initial.expertiseStr);
  const [samplePromptsStr, setSamplePromptsStr] = useState(initial.samplePromptsStr);
  const [category, setCategory] = useState(initial.category);
  const [tagsStr, setTagsStr] = useState(initial.tagsStr);

  // Content state
  const [systemPrompt, setSystemPrompt] = useState(initial.systemPrompt);

  const current: Fields = {
    name, description, avatar, model, maxTurns, toolsStr, disallowedToolsStr, skillsStr, memory, background,
    intro, expertiseStr, samplePromptsStr, category, tagsStr, systemPrompt,
  };
  const dirty = open && (Object.keys(initial) as (keyof Fields)[]).some((key) => current[key] !== initial[key]);

  const buildMetadata = (): Partial<SubagentMetadata> => {
    const tools = toolsStr.split(',').map((s) => s.trim()).filter(Boolean);
    const disallowedTools = disallowedToolsStr.split(',').map((s) => s.trim()).filter(Boolean);
    const skills = skillsStr.split(',').map((s) => s.trim()).filter(Boolean);
    // Display fields are line-separated (intro is single paragraph, expertise
    // and samplePrompts are bullet-per-line). Tags use comma separator to match
    // the existing toolsStr convention.
    const expertise = expertiseStr.split('\n').map((s) => s.trim()).filter(Boolean);
    const samplePrompts = samplePromptsStr.split('\n').map((s) => s.trim()).filter(Boolean);
    const tags = tagsStr.split(',').map((s) => s.trim()).filter(Boolean);
    return {
      name: name.trim(),
      description: description.trim(),
      avatar: avatar.trim() || undefined,
      model: model.trim() || 'inherit',
      maxTurns: maxTurns ? parseInt(maxTurns, 10) : undefined,
      tools: tools.length > 0 ? tools : undefined,
      disallowedTools: disallowedTools.length > 0 ? disallowedTools : undefined,
      skills: skills.length > 0 ? skills : undefined,
      memory,
      background,
      intro: intro.trim() || undefined,
      expertise: expertise.length > 0 ? expertise : undefined,
      samplePrompts: samplePrompts.length > 0 ? samplePrompts : undefined,
      category: category.trim() || undefined,
      tags: tags.length > 0 ? tags : undefined,
      // Identity is not an editable field either: `roleId` is what every team
      // membership points at (minted by ensureRoleId on first team membership),
      // `createdAt` drives the newest-first sort. An existing agent's values
      // are carried over verbatim and never regenerated. A new agent is
      // stamped with `createdAt` here, on its first save; a legacy agent that
      // has no stamp stays unstamped on purpose — stamping it on edit would
      // falsely mark it the newest.
      roleId: agent?.roleId,
      createdAt: agent ? agent.createdAt : Date.now(),
      // Provenance is not an editable field: carried over verbatim so a save
      // cannot quietly launder a plugin's agent into a user-authored one. A new
      // agent has none. (The detail views disable Edit for plugin agents, so
      // this is the invariant behind that gate, not a second entry point.)
      source: agent?.source,
    };
  };

  const handleSave = async (): Promise<boolean> => {
    // The window stays on the page while it fades out; a key press there saves nothing.
    if (!open) return false;
    if (!name.trim()) return false;
    // A plugin owns this AGENT.md — the next plugin update overwrites whatever
    // is saved here. The only entry point (AgentsSection's Edit) is disabled
    // for plugin agents; this keeps the invariant local to the save itself.
    if (agent && isPluginOwnedAgent(agent)) return false;
    const trimmed = name.trim();
    const creatingOrRenaming = !agent || nameChanged;
    // Re-checked here, not only via the disabled button: the registry may have
    // learned a name since the last render.
    if (creatingOrRenaming && isItemNameTaken(trimmed, agent?.name ?? null, agentNamesInUse())) {
      setRefusedName(trimmed);
      return false;
    }
    setSaving(true);
    setSaveFailed(false);
    try {
      const metadata = buildMetadata();
      const md = serializeAgentMd(metadata, systemPrompt);
      // Always the file being edited, renamed or not: its folder need not be
      // named after the agent, so an unchanged name could still point at another
      // agent's folder. saveItemToAbuDir writes this agent's own file in place,
      // wherever it lives (a project agent stays in its project), and on a
      // rename — and only a rename — moves its folder to the name within the
      // same parent (a move onto an occupied folder fails instead of
      // overwriting).
      const oldPath = agent?.filePath;
      // A letter-case-only rename moves this agent's own folder: on the
      // case-insensitive file systems the manifest already "at" the target is
      // its own, so the must-be-new probe would wrongly refuse it.
      const mustBeNew = !agent || (nameChanged && trimmed.toLowerCase() !== agent.name.toLowerCase());
      await saveItemToAbuDir('agents', 'AGENT.md', trimmed, md, oldPath, { mustBeNew, renaming: !!agent && nameChanged });
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
      console.error('[AgentEditor] Save failed:', err);
      setSaveFailed(true);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const handleSaveAndTest = async () => {
    const ok = await handleSave();
    if (!ok) return;
    navigateToChatWithInput(format(t.toolbox.agentTestPrompt, { name: name.trim() }));
  };

  const isValid = nameValid && !nameConflict && !nameRefusedAsInvalid;
  const nameRefused = Boolean(name.trim()) && (!nameValid || nameConflict || nameRefusedAsInvalid);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!next) onClose(); }}
      title={agent ? t.toolbox.agentEditorTitleEdit : t.toolbox.agentEditorTitleNew}
      size="lg"
      closeButton
      dirty={dirty}
      // The window opens on the name, past the avatar button beside it.
      initialFocus={(box) => box.querySelector<HTMLElement>('input')}
      onCloseAutoFocus={onCloseAutoFocus}
      footer={(
        // The failure is said beside the buttons, where the save was pressed: the form above scrolls.
        <div className="flex w-full flex-col gap-3">
          {saveFailed && <InlineMessage tone="danger">{t.toolbox.itemSaveFailed}</InlineMessage>}
          <div className="flex justify-end gap-2">
            <DialogClose asChild><Button variant="plain">{t.common.cancel}</Button></DialogClose>
            <Button variant="secondary" icon={AppIcons.continue} busy={saving} disabled={!isValid} onClick={() => { void handleSaveAndTest(); }}>
              {t.toolbox.agentSaveAndTest}
            </Button>
            <Button variant="primary" icon={AppIcons.save} busy={saving} disabled={!isValid} onClick={() => { void handleSave(); }} data-testid="agent-editor-save">
              {t.toolbox.agentSave}
            </Button>
          </div>
        </div>
      )}
    >
      <div className="space-y-4">
        {/* Metadata Section */}
        <div className="space-y-3">
          <h3 className={GROUP_TITLE}>{t.toolbox.agentEditorMetadata}</h3>

          {/* Name and avatar */}
          <div>
            <label htmlFor={`${id}-name`} className={FIELD_LABEL}>{t.toolbox.agentEditorName}</label>
            <div className="flex items-center gap-2">
              <AvatarPicker value={avatar} onChange={setAvatar}>
                <AgentAvatar agent={{ name: agent?.name ?? name, filePath: agent?.filePath, avatar }} size="lg" />
              </AvatarPicker>
              <TextField
                id={`${id}-name`}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-agent"
                invalid={nameRefused}
                className="min-w-0 flex-1"
              />
            </div>
            {name.trim() && (!nameValid || nameRefusedAsInvalid) && (
              <p className={REFUSED}><StatusIcon tone="danger" size="sm" />{t.toolbox.nameFormatHint}</p>
            )}
            {nameConflict && (
              <p className={REFUSED}><StatusIcon tone="danger" size="sm" />{t.toolbox.agentNameTakenHint}</p>
            )}
          </div>

          {/* Description */}
          <div>
            <label htmlFor={`${id}-description`} className={FIELD_LABEL}>{t.toolbox.agentEditorDescription}</label>
            <TextField id={`${id}-description`} value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>

          {/* Model + Max Turns row */}
          <div className="flex gap-3">
            <div className="min-w-0 flex-1">
              {/* The select carries this text as its name. */}
              <div className={FIELD_LABEL}>{t.toolbox.agentModel}</div>
              <Select
                fullWidth
                label={t.toolbox.agentModel}
                value={model || INHERIT_MODEL}
                onValueChange={(next) => setModel(next === INHERIT_MODEL ? '' : next)}
                options={[
                  { value: INHERIT_MODEL, label: t.toolbox.agentModelInherit },
                  ...(getActiveProvider(useSettingsStore.getState())?.models ?? []).map((m) => ({
                    value: m.id,
                    label: m.label,
                  })),
                ]}
              />
            </div>
            <div className="w-32">
              <label htmlFor={`${id}-max-turns`} className={FIELD_LABEL}>{t.toolbox.agentMaxTurns}</label>
              <TextField
                id={`${id}-max-turns`}
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

          {/* Tools */}
          <div>
            <label htmlFor={`${id}-tools`} className={FIELD_LABEL}>{t.toolbox.agentTools}</label>
            <TextField
              id={`${id}-tools`}
              value={toolsStr}
              onChange={(e) => setToolsStr(e.target.value)}
              placeholder="web_search, read_file, abu-browser__*"
            />
            <p className={HINT}>{t.toolbox.agentToolPatternsHint}</p>
            {unmatchedTools.length > 0 && (
              <div className="mt-2">
                <InlineMessage tone="warning">{format(t.toolbox.agentUnknownToolsWarning, { tools: unmatchedTools.join(', ') })}</InlineMessage>
              </div>
            )}
          </div>

          {/* Disallowed Tools */}
          <div>
            <label htmlFor={`${id}-disallowed-tools`} className={FIELD_LABEL}>{t.toolbox.agentDisallowedTools}</label>
            <TextField
              id={`${id}-disallowed-tools`}
              value={disallowedToolsStr}
              onChange={(e) => setDisallowedToolsStr(e.target.value)}
              placeholder="execute_command, abu-browser__*"
            />
            <p className={HINT}>{t.toolbox.agentToolPatternsHint}</p>
            {unmatchedDisallowedTools.length > 0 && (
              <div className="mt-2">
                <InlineMessage tone="warning">{format(t.toolbox.agentUnknownToolsWarning, { tools: unmatchedDisallowedTools.join(', ') })}</InlineMessage>
              </div>
            )}
          </div>

          {/* Skills */}
          <div>
            <label htmlFor={`${id}-skills`} className={FIELD_LABEL}>{t.toolbox.agentSkills}</label>
            <TextField
              id={`${id}-skills`}
              value={skillsStr}
              onChange={(e) => setSkillsStr(e.target.value)}
              placeholder="deep-research, code-review"
            />
          </div>

          {/* Memory + Background row */}
          <div className="flex items-end gap-3">
            <div className="min-w-0 flex-1">
              {/* The select carries this text as its name. */}
              <div className={FIELD_LABEL}>{t.toolbox.agentMemory}</div>
              <Select
                fullWidth
                label={t.toolbox.agentMemory}
                value={memory}
                onValueChange={(v) => setMemory(v as 'session' | 'project' | 'user')}
                options={[
                  { value: 'session', label: t.toolbox.agentMemorySession },
                  { value: 'project', label: t.toolbox.agentMemoryProject },
                  { value: 'user', label: t.toolbox.agentMemoryUser },
                ]}
              />
            </div>
            <div className="flex h-7 items-center gap-2">
              <label htmlFor={`${id}-background`} className="text-ui-sm font-medium text-label-secondary">{t.toolbox.agentBackground}</label>
              <Switch id={`${id}-background`} checked={background} onCheckedChange={setBackground} />
            </div>
          </div>

          {/* Intro — shown on chat welcome screen and toolbox detail */}
          <div>
            <label htmlFor={`${id}-intro`} className={FIELD_LABEL}>{t.toolbox.agentIntro}</label>
            <TextArea
              id={`${id}-intro`}
              value={intro}
              onChange={(e) => setIntro(e.target.value)}
              rows={2}
              placeholder={t.toolbox.agentIntroPlaceholder}
            />
          </div>

          {/* Expertise — one item per line, rendered as bullets */}
          <div>
            <label htmlFor={`${id}-expertise`} className={FIELD_LABEL}>{t.toolbox.agentExpertise}</label>
            <TextArea
              id={`${id}-expertise`}
              value={expertiseStr}
              onChange={(e) => setExpertiseStr(e.target.value)}
              rows={3}
              placeholder={t.toolbox.agentExpertisePlaceholder}
            />
          </div>

          {/* Sample Prompts — one per line, clickable in toolbox detail */}
          <div>
            <label htmlFor={`${id}-sample-prompts`} className={FIELD_LABEL}>{t.toolbox.agentSamplePrompts}</label>
            <TextArea
              id={`${id}-sample-prompts`}
              value={samplePromptsStr}
              onChange={(e) => setSamplePromptsStr(e.target.value)}
              rows={3}
              placeholder={t.toolbox.agentSamplePromptsPlaceholder}
            />
          </div>

          {/* Category + Tags row */}
          <div className="flex gap-3">
            <div className="min-w-0 flex-1">
              <label htmlFor={`${id}-category`} className={FIELD_LABEL}>{t.toolbox.agentCategoryField}</label>
              <TextField
                id={`${id}-category`}
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="tech-engineering"
              />
            </div>
            <div className="min-w-0 flex-1">
              <label htmlFor={`${id}-tags`} className={FIELD_LABEL}>{t.toolbox.agentTagsField}</label>
              <TextField
                id={`${id}-tags`}
                value={tagsStr}
                onChange={(e) => setTagsStr(e.target.value)}
                placeholder={t.toolbox.agentTagsPlaceholder}
              />
            </div>
          </div>
        </div>

        {/* Content Section */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 id={`${id}-content`} className={GROUP_TITLE}>{t.toolbox.agentEditorContent}</h3>
            <Pressable
              aria-pressed={showPreview}
              onClick={() => setShowPreview(!showPreview)}
              className={cn(
                'h-5 rounded-control px-2 text-caption',
                showPreview ? 'bg-fill-selected text-label' : 'text-label-tertiary hover:bg-fill-hover hover:text-label',
              )}
            >
              {t.toolbox.agentEditorPreview}
            </Pressable>
          </div>

          {showPreview ? (
            <div className="min-h-50 max-h-100 overflow-y-auto rounded-control border border-separator p-4">
              <MarkdownRenderer content={systemPrompt || '*No content yet*'} />
            </div>
          ) : (
            <TextArea
              aria-labelledby={`${id}-content`}
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="Write agent system prompt in Markdown..."
              className="min-h-50 max-h-100 font-code"
            />
          )}
        </div>
      </div>
    </Dialog>
  );
}
