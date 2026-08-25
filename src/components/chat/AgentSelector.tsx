import { useEffect, useRef, useState } from 'react';
import { AtSign, Check, ChevronDown, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/i18n';
import type { SubagentMetadata } from '@/types';
import { getAgentToolSummary } from '@/utils/agentToolPresentation';
import { getAllTools } from '@/core/tools/registry';

interface AgentSelectorProps {
  agents: SubagentMetadata[];
  selectedName: string | null;
  onSelect: (agent: { name: string; description: string } | null) => void;
  disabledAgentSet: Set<string>;
}

/**
 * Toolbar dropdown for switching the active subagent on the next message.
 * Mirrors the `selectedAgent` state ChatInput already maintains for `@mention` —
 * this just exposes a non-typing entry point next to the model picker.
 */
export default function AgentSelector({
  agents,
  selectedName,
  onSelect,
  disabledAgentSet,
}: AgentSelectorProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const knownToolNames = getAllTools().map((tool) => tool.name);

  // Filter out abu (the default fallback agent) and any user-disabled agents
  const available = agents.filter(
    (a) => a.name !== 'abu' && !disabledAgentSet.has(a.name),
  );

  const selected = selectedName
    ? available.find((a) => a.name === selectedName)
    : undefined;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const handlePick = (agent: SubagentMetadata) => {
    onSelect({ name: agent.name, description: agent.description });
    setOpen(false);
  };

  const handleClear = () => {
    onSelect(null);
    setOpen(false);
  };

  return (
    <div className="relative" ref={wrapperRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'btn-ghost flex items-center gap-1 px-2 py-1 text-minor font-medium rounded-md transition-colors',
          selected
            ? 'text-[var(--abu-clay)] hover:bg-[var(--abu-clay-bg)]'
            : 'text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)]',
        )}
      >
        {selected ? (
          <>
            <span className="text-body leading-none">{selected.avatar ?? '@'}</span>
            <span>{selected.name}</span>
          </>
        ) : (
          <>
            <AtSign className="h-3.5 w-3.5" />
            <span>{t.chat.pickAgent}</span>
          </>
        )}
        <ChevronDown className={cn('h-3 w-3 transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="absolute bottom-full left-0 mb-1.5 z-50 min-w-[240px] max-w-[320px] max-h-[280px] overflow-y-auto rounded-lg border border-[var(--abu-border)] bg-[var(--abu-bg-base)] shadow-lg py-1">
          {available.length === 0 ? (
            <div className="px-3 py-2 text-minor text-[var(--abu-text-muted)]">
              {t.chat.pickAgentEmpty}
            </div>
          ) : (
            <>
              {selected && (
                <>
                  <button
                    onClick={handleClear}
                    className="w-full flex items-center gap-2 px-3 py-2 text-minor text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)] transition-colors"
                  >
                    <X className="h-3.5 w-3.5" />
                    <span>{t.chat.pickAgentClear}</span>
                  </button>
                  <div className="my-1 mx-2 border-t border-[var(--abu-border)]" />
                </>
              )}
              {available.map((a) => {
                const isActive = selected?.name === a.name;
                const toolSummary = getAgentToolSummary(a.tools, a.disallowedTools, knownToolNames);
                const toolLabel = toolSummary.invalidField
                  ? t.toolbox.agentInvalidTools
                  : toolSummary.isUnrestricted
                    ? t.toolbox.agentAllTools
                    : t.toolbox.toolCount.replace('{count}', String(toolSummary.toolNames.length));
                return (
                  <button
                    key={a.name}
                    onClick={() => handlePick(a)}
                    className={cn(
                      'w-full flex items-start gap-2 px-3 py-2 text-left transition-colors',
                      isActive
                        ? 'bg-[var(--abu-clay-bg)]'
                        : 'hover:bg-[var(--abu-bg-hover)]',
                    )}
                  >
                    <span className="text-body leading-none mt-0.5 shrink-0">{a.avatar ?? '🤖'}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className={cn(
                          'text-body font-medium truncate',
                          isActive ? 'text-[var(--abu-clay)]' : 'text-[var(--abu-text-primary)]',
                        )}>
                          {a.name}
                        </span>
                        <span
                          className="shrink-0 rounded-full bg-[var(--abu-bg-active)] px-1.5 py-0.5 text-caption text-[var(--abu-text-tertiary)]"
                          title={toolSummary.invalidField ? t.toolbox.agentInvalidTools : toolSummary.toolNames.join(', ')}
                        >
                          {toolLabel}
                        </span>
                        {isActive && <Check className="h-3 w-3 text-[var(--abu-clay)] shrink-0" />}
                      </div>
                      <p className="text-caption text-[var(--abu-text-tertiary)] mt-0.5 line-clamp-2 leading-snug">
                        {a.description}
                      </p>
                    </div>
                  </button>
                );
              })}
            </>
          )}
        </div>
      )}
    </div>
  );
}
