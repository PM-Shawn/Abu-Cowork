import { useEffect } from 'react';
import { X, Bot, Cpu, Wrench, ShieldOff, Wand2, Database, RotateCcw, Cog, Download, Pencil } from 'lucide-react';
import { useI18n } from '@/i18n';
import MarkdownRenderer from '@/components/chat/MarkdownRenderer';
import type { SubagentDefinition } from '@/types';
import type { MarketplaceItem } from '@/types/marketplace';
import { parseAgentFile } from '@/core/agent/registry';
import { useSettingsStore, resolveAgentModel, getEffectiveModel } from '@/stores/settingsStore';

interface AgentDetailModalProps {
  agent: SubagentDefinition | null;
  template: MarketplaceItem | null;
  isInstalled: boolean;
  onClose: () => void;
  onInstall?: () => void;
  onEdit?: () => void;
}

export default function AgentDetailModal({
  agent,
  template,
  isInstalled,
  onClose,
  onInstall,
  onEdit,
}: AgentDetailModalProps) {
  const { t } = useI18n();

  // Escape key to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Derive display data from either installed agent or template
  let name = agent?.name ?? template?.name ?? '';
  let description = agent?.description ?? template?.description ?? '';
  let avatar: string | undefined;
  let model: string | undefined;
  let tools: string[] | undefined;
  let disallowedTools: string[] | undefined;
  let skills: string[] | undefined;
  let memory: 'session' | 'project' | 'user' | undefined;
  let maxTurns: number | undefined;
  let background: boolean | undefined;
  let systemPrompt: string | undefined;

  if (agent) {
    avatar = agent.avatar;
    model = agent.model;
    tools = agent.tools;
    disallowedTools = agent.disallowedTools;
    skills = agent.skills;
    memory = agent.memory;
    maxTurns = agent.maxTurns;
    background = agent.background;
    systemPrompt = agent.systemPrompt;
  } else if (template?.content) {
    // Parse the template content for metadata preview
    const parsed = parseAgentFile(template.content, '__preview__');
    if (parsed) {
      name = parsed.name;
      description = parsed.description;
      avatar = parsed.avatar;
      model = parsed.model;
      tools = parsed.tools;
      disallowedTools = parsed.disallowedTools;
      skills = parsed.skills;
      memory = parsed.memory;
      maxTurns = parsed.maxTurns;
      background = parsed.background;
      systemPrompt = parsed.systemPrompt;
    }
  }

  // Resolve the actual model that will be used at runtime
  const settingsState = useSettingsStore();
  const resolvedModel = resolveAgentModel(model, settingsState);
  const isInherit = !model || model === 'inherit';
  const globalModel = getEffectiveModel(settingsState);

  const memoryLabel = memory === 'project'
    ? t.toolbox.agentMemoryProject
    : memory === 'user'
      ? t.toolbox.agentMemoryUser
      : t.toolbox.agentMemorySession;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[80vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--abu-bg-active)]">
          <div className="flex items-center gap-2">
            {avatar ? (
              <span className="text-xl">{avatar}</span>
            ) : (
              <Bot className="h-5 w-5 text-blue-500" />
            )}
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
          {/* Description */}
          <p className="text-sm text-[var(--abu-text-secondary)]">{description}</p>

          {/* Model */}
          <div className="space-y-1">
            <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--abu-text-tertiary)]">
              <Cpu className="h-3.5 w-3.5" />
              {t.toolbox.agentModel}
            </div>
            <p className="text-xs text-[var(--abu-text-secondary)] pl-5 font-mono">
              {isInherit
                ? `${t.toolbox.agentModelInherit}（${globalModel}）`
                : resolvedModel !== model
                  ? `${resolvedModel}（${t.toolbox.agentModelInherit}）`
                  : model}
            </p>
          </div>

          {/* Tools */}
          {tools && tools.length > 0 && (
            <div className="space-y-1">
              <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--abu-text-tertiary)]">
                <Wrench className="h-3.5 w-3.5" />
                {t.toolbox.agentTools}
              </div>
              <div className="flex flex-wrap gap-1 pl-5">
                {tools.map((tool) => (
                  <span key={tool} className="px-2 py-0.5 rounded bg-blue-50 text-blue-600 text-[10px] font-mono">
                    {tool}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Disallowed Tools */}
          {disallowedTools && disallowedTools.length > 0 && (
            <div className="space-y-1">
              <div className="flex items-center gap-1.5 text-xs font-medium text-red-500">
                <ShieldOff className="h-3.5 w-3.5" />
                {t.toolbox.agentDisallowedTools}
              </div>
              <div className="flex flex-wrap gap-1 pl-5">
                {disallowedTools.map((tool) => (
                  <span key={tool} className="px-2 py-0.5 rounded bg-red-50 text-red-600 text-[10px] font-mono">
                    {tool}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Skills */}
          {skills && skills.length > 0 && (
            <div className="space-y-1">
              <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--abu-text-tertiary)]">
                <Wand2 className="h-3.5 w-3.5" />
                {t.toolbox.agentSkills}
              </div>
              <div className="flex flex-wrap gap-1 pl-5">
                {skills.map((s) => (
                  <span key={s} className="px-2 py-0.5 rounded bg-purple-50 text-purple-600 text-[10px] font-mono">
                    {s}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Memory + Max Turns + Background */}
          <div className="flex gap-4 flex-wrap">
            {memory && (
              <div className="space-y-1">
                <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--abu-text-tertiary)]">
                  <Database className="h-3.5 w-3.5" />
                  {t.toolbox.agentMemory}
                </div>
                <p className="text-xs text-[var(--abu-text-secondary)] pl-5">{memoryLabel}</p>
              </div>
            )}
            {maxTurns && (
              <div className="space-y-1">
                <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--abu-text-tertiary)]">
                  <RotateCcw className="h-3.5 w-3.5" />
                  {t.toolbox.agentMaxTurns}
                </div>
                <p className="text-xs text-[var(--abu-text-secondary)] pl-5">{maxTurns}</p>
              </div>
            )}
            {background !== undefined && (
              <div className="space-y-1">
                <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--abu-text-tertiary)]">
                  <Cog className="h-3.5 w-3.5" />
                  {t.toolbox.agentBackground}
                </div>
                <p className="text-xs text-[var(--abu-text-secondary)] pl-5">{background ? '✓' : '✗'}</p>
              </div>
            )}
          </div>

          {/* System Prompt */}
          {systemPrompt && (
            <div className="space-y-1">
              <div className="text-xs font-medium text-[var(--abu-text-tertiary)]">{t.toolbox.agentSystemPrompt}</div>
              <div className="border border-[var(--abu-border)] rounded-lg p-3 bg-[var(--abu-bg-muted)] max-h-60 overflow-y-auto">
                <MarkdownRenderer content={systemPrompt} />
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
              {t.toolbox.agentEdit}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
