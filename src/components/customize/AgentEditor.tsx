import { useState } from 'react';
import { ArrowLeft, Save, Play } from 'lucide-react';
import { useI18n, format } from '@/i18n';
import { serializeAgentMd, agentRegistry, getBuiltinAgentNames } from '@/core/agent/registry';
import { getAllTools } from '@/core/tools/registry';
import { Toggle } from '@/components/ui/toggle';
import { Select } from '@/components/ui/select';
import type { SubagentDefinition, SubagentMetadata } from '@/types';
import { useSettingsStore, getActiveProvider } from '@/stores/settingsStore';
import { navigateToChatWithInput } from '@/utils/navigation';
import { useItemName, isItemNameTaken } from '@/hooks/useItemName';
import { saveItemToAbuDir, ITEM_EXISTS_CODE, ITEM_NAME_INVALID_CODE } from '@/utils/itemStorage';
import { cn } from '@/lib/utils';
import { getUnmatchedAgentToolPatterns } from '@/utils/agentToolPresentation';
import { isPluginOwnedAgent } from '@/utils/agentSource';
import MarkdownRenderer from '@/components/chat/MarkdownRenderer';

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
}

export default function AgentEditor({ agent, onClose, onSave }: AgentEditorProps) {
  const { t } = useI18n();
  const [saving, setSaving] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  // Name validation via shared hook
  const { name, setName, nameValid, nameTaken, nameChanged } = useItemName(agent?.name ?? null, {
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
  // Any other save failure: shown under the Save button, cleared on retry.
  const [saveFailed, setSaveFailed] = useState(false);
  const [description, setDescription] = useState(agent?.description ?? '');
  const [avatar, setAvatar] = useState(agent?.avatar ?? '');
  const [model, setModel] = useState(() => {
    if (!agent?.model || agent.model === 'inherit') return '';
    // If the agent has a specific model, check if it's available in current provider
    const providerModels = getActiveProvider(useSettingsStore.getState())?.models ?? [];
    if (providerModels.some((m) => m.id === agent.model)) return agent.model;
    // Model not available in current provider → show as inherit (will fallback at runtime anyway)
    return '';
  });
  const [maxTurns, setMaxTurns] = useState(agent?.maxTurns?.toString() ?? '');
  const [toolsStr, setToolsStr] = useState((agent?.tools ?? []).join(', '));
  const [disallowedToolsStr, setDisallowedToolsStr] = useState((agent?.disallowedTools ?? []).join(', '));
  const [skillsStr, setSkillsStr] = useState((agent?.skills ?? []).join(', '));
  const [memory, setMemory] = useState<'session' | 'project' | 'user'>(agent?.memory ?? 'session');
  const [background, setBackground] = useState(agent?.background ?? false);
  const knownToolNames = getAllTools().map((tool) => tool.name);
  const unmatchedTools = getUnmatchedAgentToolPatterns(toolsStr, knownToolNames);
  const unmatchedDisallowedTools = getUnmatchedAgentToolPatterns(disallowedToolsStr, knownToolNames);

  // Display-only fields rendered in toolbox detail panel + chat welcome.
  // All optional; users can leave them blank and the agent still works.
  const [intro, setIntro] = useState(agent?.intro ?? '');
  const [expertiseStr, setExpertiseStr] = useState((agent?.expertise ?? []).join('\n'));
  const [samplePromptsStr, setSamplePromptsStr] = useState((agent?.samplePrompts ?? []).join('\n'));
  const [category, setCategory] = useState(agent?.category ?? '');
  const [tagsStr, setTagsStr] = useState((agent?.tags ?? []).join(', '));

  // Content state
  const [systemPrompt, setSystemPrompt] = useState(agent?.systemPrompt ?? '');

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
      // agent's folder. saveItemToAbuDir writes in place when the folder already
      // matches, moves the agent's own ~/.abu folder to the name otherwise (a
      // move onto an occupied folder fails instead of overwriting), and only
      // copies from anywhere else.
      const oldPath = agent?.filePath;
      // A letter-case-only rename moves this agent's own folder: on the
      // case-insensitive file systems the manifest already "at" the target is
      // its own, so the must-be-new probe would wrongly refuse it.
      const mustBeNew = !agent || (nameChanged && trimmed.toLowerCase() !== agent.name.toLowerCase());
      await saveItemToAbuDir('agents', 'AGENT.md', trimmed, md, oldPath, { mustBeNew });
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

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="shrink-0 flex items-center gap-3 px-4 py-3 border-b border-[var(--abu-border)]">
        <button
          onClick={onClose}
          className="p-1.5 rounded-lg text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-muted)] transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <h2 className="text-body font-semibold text-[var(--abu-text-primary)] flex-1">{t.toolbox.agentEditorTitle}</h2>
        <div className="flex flex-wrap justify-end gap-x-2 gap-y-1">
          <button
            onClick={handleSave}
            disabled={!isValid || saving}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-minor font-medium bg-[var(--abu-text-primary)] text-[var(--abu-bg-base)] hover:bg-[var(--abu-text-primary)] disabled:opacity-50 transition-colors"
          >
            <Save className="h-3.5 w-3.5" />
            {t.toolbox.agentSave}
          </button>
          <button
            onClick={handleSaveAndTest}
            disabled={!isValid || saving}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-minor font-medium bg-[var(--abu-clay)] text-white hover:bg-[var(--abu-clay-hover)] disabled:opacity-50 transition-colors"
          >
            <Play className="h-3.5 w-3.5" />
            {t.toolbox.agentSaveAndTest}
          </button>
          {saveFailed && (
            <p role="alert" className="basis-full text-right text-caption text-[var(--abu-danger)]">{t.toolbox.itemSaveFailed}</p>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {/* Metadata Section */}
        <div className="space-y-3">
          <h3 className="text-minor font-semibold text-[var(--abu-text-tertiary)] uppercase tracking-wide">
            {t.toolbox.agentEditorMetadata}
          </h3>

          {/* Name + Avatar row */}
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="block text-minor font-medium text-[var(--abu-text-secondary)] mb-1">{t.toolbox.agentEditorName}</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-agent"
                className={cn(
                  'w-full px-3 py-1.5 rounded-lg border text-body text-[var(--abu-text-primary)] bg-[var(--abu-bg-base)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)] transition-all',
                  name.trim() && (!nameValid || nameConflict || nameRefusedAsInvalid) ? 'border-[var(--abu-danger)]' : 'border-[var(--abu-border)]',
                )}
              />
              {name.trim() && (!nameValid || nameRefusedAsInvalid) && (
                <p className="text-caption text-[var(--abu-danger)] mt-1">{t.toolbox.nameFormatHint}</p>
              )}
              {nameConflict && (
                <p className="text-caption text-[var(--abu-danger)] mt-1">{t.toolbox.agentNameTakenHint}</p>
              )}
            </div>
            <div className="w-20">
              <label className="block text-minor font-medium text-[var(--abu-text-secondary)] mb-1">{t.toolbox.agentAvatar}</label>
              <input
                type="text"
                value={avatar}
                onChange={(e) => setAvatar(e.target.value)}
                placeholder="🤖"
                className="w-full px-3 py-1.5 rounded-lg border border-[var(--abu-border)] text-body text-[var(--abu-text-primary)] bg-[var(--abu-bg-base)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)] transition-all text-center"
              />
            </div>
          </div>

          {/* Description */}
          <div>
            <label className="block text-minor font-medium text-[var(--abu-text-secondary)] mb-1">{t.toolbox.agentEditorDescription}</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full px-3 py-1.5 rounded-lg border border-[var(--abu-border)] text-body text-[var(--abu-text-primary)] bg-[var(--abu-bg-base)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)] transition-all"
            />
          </div>

          {/* Model + Max Turns row */}
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="block text-minor font-medium text-[var(--abu-text-secondary)] mb-1">{t.toolbox.agentModel}</label>
              <Select
                value={model}
                onChange={setModel}
                options={[
                  { value: '', label: t.toolbox.agentModelInherit },
                  ...(getActiveProvider(useSettingsStore.getState())?.models ?? []).map((m) => ({
                    value: m.id,
                    label: m.label,
                  })),
                ]}
              />
            </div>
            <div className="w-32">
              <label className="block text-minor font-medium text-[var(--abu-text-secondary)] mb-1">{t.toolbox.agentMaxTurns}</label>
              <input
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
                className="w-full px-3 py-1.5 rounded-lg border border-[var(--abu-border)] text-body text-[var(--abu-text-primary)] bg-[var(--abu-bg-base)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)] transition-all"
              />
            </div>
          </div>

          {/* Tools */}
          <div>
            <label className="block text-minor font-medium text-[var(--abu-text-secondary)] mb-1">{t.toolbox.agentTools}</label>
            <input
              type="text"
              value={toolsStr}
              onChange={(e) => setToolsStr(e.target.value)}
              placeholder="web_search, read_file, abu-browser__*"
              className="w-full px-3 py-1.5 rounded-lg border border-[var(--abu-border)] text-body text-[var(--abu-text-primary)] bg-[var(--abu-bg-base)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)] transition-all"
            />
            <p className="text-caption text-[var(--abu-text-tertiary)] mt-1">{t.toolbox.agentToolPatternsHint}</p>
            {unmatchedTools.length > 0 && (
              <p className="text-caption text-[var(--abu-warning)] mt-1" role="alert">
                {format(t.toolbox.agentUnknownToolsWarning, { tools: unmatchedTools.join(', ') })}
              </p>
            )}
          </div>

          {/* Disallowed Tools */}
          <div>
            <label className="block text-minor font-medium text-[var(--abu-text-secondary)] mb-1">{t.toolbox.agentDisallowedTools}</label>
            <input
              type="text"
              value={disallowedToolsStr}
              onChange={(e) => setDisallowedToolsStr(e.target.value)}
              placeholder="execute_command, abu-browser__*"
              className="w-full px-3 py-1.5 rounded-lg border border-[var(--abu-border)] text-body text-[var(--abu-text-primary)] bg-[var(--abu-bg-base)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)] transition-all"
            />
            <p className="text-caption text-[var(--abu-text-tertiary)] mt-1">{t.toolbox.agentToolPatternsHint}</p>
            {unmatchedDisallowedTools.length > 0 && (
              <p className="text-caption text-[var(--abu-warning)] mt-1" role="alert">
                {format(t.toolbox.agentUnknownToolsWarning, { tools: unmatchedDisallowedTools.join(', ') })}
              </p>
            )}
          </div>

          {/* Skills */}
          <div>
            <label className="block text-minor font-medium text-[var(--abu-text-secondary)] mb-1">{t.toolbox.agentSkills}</label>
            <input
              type="text"
              value={skillsStr}
              onChange={(e) => setSkillsStr(e.target.value)}
              placeholder="deep-research, code-review"
              className="w-full px-3 py-1.5 rounded-lg border border-[var(--abu-border)] text-body text-[var(--abu-text-primary)] bg-[var(--abu-bg-base)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)] transition-all"
            />
          </div>

          {/* Memory + Background row */}
          <div className="flex gap-3 items-end">
            <div className="flex-1">
              <label className="block text-minor font-medium text-[var(--abu-text-secondary)] mb-1">{t.toolbox.agentMemory}</label>
              <Select
                value={memory}
                onChange={(v) => setMemory(v as 'session' | 'project' | 'user')}
                options={[
                  { value: 'session', label: t.toolbox.agentMemorySession },
                  { value: 'project', label: t.toolbox.agentMemoryProject },
                  { value: 'user', label: t.toolbox.agentMemoryUser },
                ]}
              />
            </div>
            <div className="flex items-center gap-2 pb-1">
              <label className="text-minor font-medium text-[var(--abu-text-secondary)]">{t.toolbox.agentBackground}</label>
              <Toggle checked={background} onChange={() => setBackground(!background)} size="md" />
            </div>
          </div>

          {/* Intro — shown on chat welcome screen and toolbox detail */}
          <div>
            <label className="block text-minor font-medium text-[var(--abu-text-secondary)] mb-1">{t.toolbox.agentIntro}</label>
            <textarea
              value={intro}
              onChange={(e) => setIntro(e.target.value)}
              rows={2}
              placeholder={t.toolbox.agentIntroPlaceholder}
              className="w-full px-3 py-2 rounded-lg border border-[var(--abu-border)] text-body text-[var(--abu-text-primary)] bg-[var(--abu-bg-base)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)] transition-all resize-y"
            />
          </div>

          {/* Expertise — one item per line, rendered as bullets */}
          <div>
            <label className="block text-minor font-medium text-[var(--abu-text-secondary)] mb-1">{t.toolbox.agentExpertise}</label>
            <textarea
              value={expertiseStr}
              onChange={(e) => setExpertiseStr(e.target.value)}
              rows={3}
              placeholder={t.toolbox.agentExpertisePlaceholder}
              className="w-full px-3 py-2 rounded-lg border border-[var(--abu-border)] text-body text-[var(--abu-text-primary)] bg-[var(--abu-bg-base)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)] transition-all resize-y"
            />
          </div>

          {/* Sample Prompts — one per line, clickable in toolbox detail */}
          <div>
            <label className="block text-minor font-medium text-[var(--abu-text-secondary)] mb-1">{t.toolbox.agentSamplePrompts}</label>
            <textarea
              value={samplePromptsStr}
              onChange={(e) => setSamplePromptsStr(e.target.value)}
              rows={3}
              placeholder={t.toolbox.agentSamplePromptsPlaceholder}
              className="w-full px-3 py-2 rounded-lg border border-[var(--abu-border)] text-body text-[var(--abu-text-primary)] bg-[var(--abu-bg-base)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)] transition-all resize-y"
            />
          </div>

          {/* Category + Tags row */}
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="block text-minor font-medium text-[var(--abu-text-secondary)] mb-1">{t.toolbox.agentCategoryField}</label>
              <input
                type="text"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="tech-engineering"
                className="w-full px-3 py-1.5 rounded-lg border border-[var(--abu-border)] text-body text-[var(--abu-text-primary)] bg-[var(--abu-bg-base)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)] transition-all"
              />
            </div>
            <div className="flex-1">
              <label className="block text-minor font-medium text-[var(--abu-text-secondary)] mb-1">{t.toolbox.agentTagsField}</label>
              <input
                type="text"
                value={tagsStr}
                onChange={(e) => setTagsStr(e.target.value)}
                placeholder={t.toolbox.agentTagsPlaceholder}
                className="w-full px-3 py-1.5 rounded-lg border border-[var(--abu-border)] text-body text-[var(--abu-text-primary)] bg-[var(--abu-bg-base)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)] transition-all"
              />
            </div>
          </div>
        </div>

        {/* Content Section */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-minor font-semibold text-[var(--abu-text-tertiary)] uppercase tracking-wide">
              {t.toolbox.agentEditorContent}
            </h3>
            <button
              onClick={() => setShowPreview(!showPreview)}
              className={`text-caption px-2 py-0.5 rounded-full transition-colors ${
                showPreview
                  ? 'bg-[var(--abu-text-primary)] text-[var(--abu-bg-base)]'
                  : 'bg-[var(--abu-bg-muted)] text-[var(--abu-text-tertiary)] hover:bg-[var(--abu-border)]'
              }`}
            >
              {t.toolbox.agentEditorPreview}
            </button>
          </div>

          {showPreview ? (
            <div className="border border-[var(--abu-border)] rounded-lg p-4 bg-[var(--abu-bg-base)] min-h-[200px] max-h-[400px] overflow-y-auto">
              <MarkdownRenderer content={systemPrompt || '*No content yet*'} />
            </div>
          ) : (
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="Write agent system prompt in Markdown..."
              className="w-full min-h-[200px] max-h-[400px] px-3 py-2 rounded-lg border border-[var(--abu-border)] text-body text-[var(--abu-text-primary)] bg-[var(--abu-bg-base)] font-mono focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)] transition-all resize-y"
            />
          )}
        </div>
      </div>
    </div>
  );
}
