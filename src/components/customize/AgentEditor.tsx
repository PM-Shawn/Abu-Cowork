import { useState } from 'react';
import { ArrowLeft, Save, Play } from 'lucide-react';
import { useI18n, format } from '@/i18n';
import { serializeAgentMd } from '@/core/agent/registry';
import { Toggle } from '@/components/ui/toggle';
import { Select } from '@/components/ui/select';
import type { SubagentDefinition, SubagentMetadata } from '@/types';
import { useSettingsStore, getActiveProvider } from '@/stores/settingsStore';
import { navigateToChatWithInput } from '@/utils/navigation';
import { useItemName } from '@/hooks/useItemName';
import { saveItemToAbuDir } from '@/utils/itemStorage';
import { cn } from '@/lib/utils';
import MarkdownRenderer from '@/components/chat/MarkdownRenderer';

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
  const { name, setName, nameValid, nameChanged } = useItemName(agent?.name ?? null);
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
    };
  };

  const handleSave = async (): Promise<boolean> => {
    if (!name.trim()) return false;
    setSaving(true);
    try {
      const metadata = buildMetadata();
      const md = serializeAgentMd(metadata, systemPrompt);
      const oldPath = (agent?.filePath && nameChanged) ? agent.filePath : undefined;
      await saveItemToAbuDir('agents', 'AGENT.md', name.trim(), md, oldPath);
      await onSave();
      return true;
    } catch (err) {
      console.error('[AgentEditor] Save failed:', err);
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

  const isValid = nameValid;

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
        <h2 className="text-sm font-semibold text-[var(--abu-text-primary)] flex-1">{t.toolbox.agentEditorTitle}</h2>
        <div className="flex gap-2">
          <button
            onClick={handleSave}
            disabled={!isValid || saving}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-[var(--abu-text-primary)] text-[var(--abu-bg-base)] hover:bg-[var(--abu-text-primary)] disabled:opacity-50 transition-colors"
          >
            <Save className="h-3.5 w-3.5" />
            {t.toolbox.agentSave}
          </button>
          <button
            onClick={handleSaveAndTest}
            disabled={!isValid || saving}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-[var(--abu-clay)] text-white hover:bg-[var(--abu-clay-hover)] disabled:opacity-50 transition-colors"
          >
            <Play className="h-3.5 w-3.5" />
            {t.toolbox.agentSaveAndTest}
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {/* Metadata Section */}
        <div className="space-y-3">
          <h3 className="text-xs font-semibold text-[var(--abu-text-tertiary)] uppercase tracking-wide">
            {t.toolbox.agentEditorMetadata}
          </h3>

          {/* Name + Avatar row */}
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="block text-xs font-medium text-[var(--abu-text-secondary)] mb-1">{t.toolbox.agentEditorName}</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-agent"
                className={cn(
                  'w-full px-3 py-1.5 rounded-lg border text-sm text-[var(--abu-text-primary)] bg-[var(--abu-bg-base)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)] transition-all',
                  name.trim() && !nameValid ? 'border-red-300' : 'border-[var(--abu-border)]',
                )}
              />
              {name.trim() && !nameValid && (
                <p className="text-[11px] text-red-500 mt-1">{t.toolbox.nameFormatHint}</p>
              )}
            </div>
            <div className="w-20">
              <label className="block text-xs font-medium text-[var(--abu-text-secondary)] mb-1">{t.toolbox.agentAvatar}</label>
              <input
                type="text"
                value={avatar}
                onChange={(e) => setAvatar(e.target.value)}
                placeholder="🤖"
                className="w-full px-3 py-1.5 rounded-lg border border-[var(--abu-border)] text-sm text-[var(--abu-text-primary)] bg-[var(--abu-bg-base)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)] transition-all text-center"
              />
            </div>
          </div>

          {/* Description */}
          <div>
            <label className="block text-xs font-medium text-[var(--abu-text-secondary)] mb-1">{t.toolbox.agentEditorDescription}</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full px-3 py-1.5 rounded-lg border border-[var(--abu-border)] text-sm text-[var(--abu-text-primary)] bg-[var(--abu-bg-base)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)] transition-all"
            />
          </div>

          {/* Model + Max Turns row */}
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="block text-xs font-medium text-[var(--abu-text-secondary)] mb-1">{t.toolbox.agentModel}</label>
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
              <label className="block text-xs font-medium text-[var(--abu-text-secondary)] mb-1">{t.toolbox.agentMaxTurns}</label>
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
                className="w-full px-3 py-1.5 rounded-lg border border-[var(--abu-border)] text-sm text-[var(--abu-text-primary)] bg-[var(--abu-bg-base)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)] transition-all"
              />
            </div>
          </div>

          {/* Tools */}
          <div>
            <label className="block text-xs font-medium text-[var(--abu-text-secondary)] mb-1">{t.toolbox.agentTools}</label>
            <input
              type="text"
              value={toolsStr}
              onChange={(e) => setToolsStr(e.target.value)}
              placeholder="web_search, read_file, write_file"
              className="w-full px-3 py-1.5 rounded-lg border border-[var(--abu-border)] text-sm text-[var(--abu-text-primary)] bg-[var(--abu-bg-base)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)] transition-all"
            />
          </div>

          {/* Disallowed Tools */}
          <div>
            <label className="block text-xs font-medium text-[var(--abu-text-secondary)] mb-1">{t.toolbox.agentDisallowedTools}</label>
            <input
              type="text"
              value={disallowedToolsStr}
              onChange={(e) => setDisallowedToolsStr(e.target.value)}
              placeholder="execute_command"
              className="w-full px-3 py-1.5 rounded-lg border border-[var(--abu-border)] text-sm text-[var(--abu-text-primary)] bg-[var(--abu-bg-base)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)] transition-all"
            />
          </div>

          {/* Skills */}
          <div>
            <label className="block text-xs font-medium text-[var(--abu-text-secondary)] mb-1">{t.toolbox.agentSkills}</label>
            <input
              type="text"
              value={skillsStr}
              onChange={(e) => setSkillsStr(e.target.value)}
              placeholder="deep-research, code-review"
              className="w-full px-3 py-1.5 rounded-lg border border-[var(--abu-border)] text-sm text-[var(--abu-text-primary)] bg-[var(--abu-bg-base)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)] transition-all"
            />
          </div>

          {/* Memory + Background row */}
          <div className="flex gap-3 items-end">
            <div className="flex-1">
              <label className="block text-xs font-medium text-[var(--abu-text-secondary)] mb-1">{t.toolbox.agentMemory}</label>
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
              <label className="text-xs font-medium text-[var(--abu-text-secondary)]">{t.toolbox.agentBackground}</label>
              <Toggle checked={background} onChange={() => setBackground(!background)} size="md" />
            </div>
          </div>

          {/* Intro — shown on chat welcome screen and toolbox detail */}
          <div>
            <label className="block text-xs font-medium text-[var(--abu-text-secondary)] mb-1">{t.toolbox.agentIntro}</label>
            <textarea
              value={intro}
              onChange={(e) => setIntro(e.target.value)}
              rows={2}
              placeholder={t.toolbox.agentIntroPlaceholder}
              className="w-full px-3 py-2 rounded-lg border border-[var(--abu-border)] text-sm text-[var(--abu-text-primary)] bg-[var(--abu-bg-base)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)] transition-all resize-y"
            />
          </div>

          {/* Expertise — one item per line, rendered as bullets */}
          <div>
            <label className="block text-xs font-medium text-[var(--abu-text-secondary)] mb-1">{t.toolbox.agentExpertise}</label>
            <textarea
              value={expertiseStr}
              onChange={(e) => setExpertiseStr(e.target.value)}
              rows={3}
              placeholder={t.toolbox.agentExpertisePlaceholder}
              className="w-full px-3 py-2 rounded-lg border border-[var(--abu-border)] text-sm text-[var(--abu-text-primary)] bg-[var(--abu-bg-base)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)] transition-all resize-y"
            />
          </div>

          {/* Sample Prompts — one per line, clickable in toolbox detail */}
          <div>
            <label className="block text-xs font-medium text-[var(--abu-text-secondary)] mb-1">{t.toolbox.agentSamplePrompts}</label>
            <textarea
              value={samplePromptsStr}
              onChange={(e) => setSamplePromptsStr(e.target.value)}
              rows={3}
              placeholder={t.toolbox.agentSamplePromptsPlaceholder}
              className="w-full px-3 py-2 rounded-lg border border-[var(--abu-border)] text-sm text-[var(--abu-text-primary)] bg-[var(--abu-bg-base)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)] transition-all resize-y"
            />
          </div>

          {/* Category + Tags row */}
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="block text-xs font-medium text-[var(--abu-text-secondary)] mb-1">{t.toolbox.agentCategoryField}</label>
              <input
                type="text"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="tech-engineering"
                className="w-full px-3 py-1.5 rounded-lg border border-[var(--abu-border)] text-sm text-[var(--abu-text-primary)] bg-[var(--abu-bg-base)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)] transition-all"
              />
            </div>
            <div className="flex-1">
              <label className="block text-xs font-medium text-[var(--abu-text-secondary)] mb-1">{t.toolbox.agentTagsField}</label>
              <input
                type="text"
                value={tagsStr}
                onChange={(e) => setTagsStr(e.target.value)}
                placeholder={t.toolbox.agentTagsPlaceholder}
                className="w-full px-3 py-1.5 rounded-lg border border-[var(--abu-border)] text-sm text-[var(--abu-text-primary)] bg-[var(--abu-bg-base)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)] transition-all"
              />
            </div>
          </div>
        </div>

        {/* Content Section */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold text-[var(--abu-text-tertiary)] uppercase tracking-wide">
              {t.toolbox.agentEditorContent}
            </h3>
            <button
              onClick={() => setShowPreview(!showPreview)}
              className={`text-[11px] px-2 py-0.5 rounded-full transition-colors ${
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
              className="w-full min-h-[200px] max-h-[400px] px-3 py-2 rounded-lg border border-[var(--abu-border)] text-sm text-[var(--abu-text-primary)] bg-[var(--abu-bg-base)] font-mono focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)] transition-all resize-y"
            />
          )}
        </div>
      </div>
    </div>
  );
}
