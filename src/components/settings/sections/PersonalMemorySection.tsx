import { useState, useEffect, useCallback, useRef } from 'react';
import { useI18n, format } from '@/i18n';
import { HelpCircle, Trash2, ChevronDown, ChevronUp } from 'lucide-react';
import { getMemoryBackend } from '@/core/memory/router';
import { loadAgentMemory } from '@/core/agent/agentMemory';
import type { MemoryEntry, MemoryCategory } from '@/core/memory/types';
import ConfirmDialog from '@/components/common/ConfirmDialog';

function getCategoryLabel(category: MemoryCategory, t: ReturnType<typeof useI18n>['t']): string {
  const map: Record<MemoryCategory, string> = {
    user_preference: t.memory.categoryPreference,
    project_knowledge: t.memory.categoryProject,
    conversation_fact: t.memory.categoryFact,
    decision: t.memory.categoryDecision,
    action_item: t.memory.categoryAction,
    conversation_index: t.memory.categoryConversationIndex,
  };
  return map[category];
}

const CATEGORY_COLORS: Record<MemoryCategory, string> = {
  user_preference: 'bg-orange-100 text-orange-700',
  project_knowledge: 'bg-purple-100 text-purple-700',
  conversation_fact: 'bg-blue-100 text-blue-700',
  decision: 'bg-green-100 text-green-700',
  action_item: 'bg-yellow-100 text-yellow-700',
  conversation_index: 'bg-[var(--abu-bg-muted)] text-[var(--abu-text-secondary)]',
};

function formatAge(timestamp: number): string {
  const diffMs = Date.now() - timestamp;
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}天前`;
  return `${Math.floor(days / 30)}个月前`;
}

export default function PersonalMemorySection() {
  const { t } = useI18n();
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [legacyContent, setLegacyContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MemoryEntry | null>(null);
  const [showTip, setShowTip] = useState(false);
  const tipRef = useRef<HTMLDivElement>(null);

  const loadEntries = useCallback(async () => {
    setLoading(true);
    try {
      const backend = getMemoryBackend();
      const items = await backend.list({ scope: 'user' });
      // Filter out conversation_index entries — internal data, not user-facing
      const visible = items.filter(e => e.category !== 'conversation_index');
      if (visible.length > 0) {
        setEntries(visible.sort((a, b) => b.updatedAt - a.updatedAt));
        setLegacyContent(null);
      } else {
        // Fallback: show legacy memory.md content if structured entries are empty
        const legacy = await loadAgentMemory('abu');
        setLegacyContent(legacy.trim() || null);
        setEntries([]);
      }
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadEntries(); }, [loadEntries]);

  // Close tip on click outside
  useEffect(() => {
    if (!showTip) return;
    const handleClick = (e: MouseEvent) => {
      if (tipRef.current && !tipRef.current.contains(e.target as Node)) {
        setShowTip(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showTip]);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      const backend = getMemoryBackend();
      await backend.remove(deleteTarget.id);
      setDeleteTarget(null);
      await loadEntries();
    } catch (err) {
      console.error('Failed to delete memory:', err);
    }
  };

  return (
    <>
      <ConfirmDialog
        open={!!deleteTarget}
        title={t.memory.deleteTitle}
        message={deleteTarget?.summary ?? ''}
        confirmText={t.common.delete}
        cancelText={t.common.cancel}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
        variant="danger"
      />

      <div className="space-y-4">
        <div>
          <div className="flex items-center gap-1.5 relative" ref={tipRef}>
            <h3 className="text-[15px] font-semibold text-[var(--abu-text-primary)]">
              {t.sidebar.personalMemoryTitle}
            </h3>
            <button
              onClick={() => setShowTip(!showTip)}
              className="text-[var(--abu-text-placeholder)] hover:text-[var(--abu-text-muted)] transition-colors"
            >
              <HelpCircle className="h-3.5 w-3.5" />
            </button>

            {showTip && (
              <div className="absolute top-full left-0 mt-2 w-[340px] p-4 bg-white rounded-xl shadow-lg border border-[var(--abu-border)] z-50 animate-in fade-in slide-in-from-top-1 duration-150">
                <div className="space-y-2.5 text-[12px] text-[var(--abu-text-tertiary)] leading-relaxed">
                  <p className="text-[13px] text-[var(--abu-text-secondary)] font-medium">{t.sidebar.memoryGuideTitle}</p>
                  <div className="space-y-1.5">
                    <p><span className="font-medium text-[var(--abu-clay)]">{t.sidebar.memoryGuidePersonalName}</span> — {t.sidebar.memoryGuidePersonalDesc}</p>
                    <p><span className="font-medium text-[#8b7ec8]">{t.sidebar.memoryGuideProjectMemoryName}</span> — {t.sidebar.memoryGuideProjectMemoryDesc}</p>
                    <p><span className="font-medium text-[var(--abu-text-secondary)]">{t.sidebar.memoryGuideProjectRulesName}</span> — {t.sidebar.memoryGuideProjectRulesDesc}</p>
                  </div>
                  <p className="text-[11px] text-[var(--abu-text-muted)] border-t border-[var(--abu-bg-active)] pt-2">{t.sidebar.memoryGuideTip}</p>
                </div>
              </div>
            )}
          </div>
          <p className="text-[13px] text-[var(--abu-text-muted)] mt-1">
            {t.sidebar.personalMemoryDesc}
          </p>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <div className="w-5 h-5 border-2 border-[var(--abu-clay)] border-t-transparent rounded-full animate-spin" />
          </div>
        ) : entries.length > 0 ? (
          <div className="space-y-2">
            <div className="text-[12px] text-[var(--abu-text-placeholder)] mb-2">
              {format(t.memory.entryCount, { count: String(entries.length) })}
            </div>
            {entries.map((entry) => (
              <div
                key={entry.id}
                className="border border-[var(--abu-border)] rounded-lg bg-[var(--abu-bg-muted)] overflow-hidden"
              >
                <div
                  className="flex items-center gap-2 px-3 py-2.5 cursor-pointer hover:bg-[var(--abu-bg-muted)] transition-colors"
                  onClick={() => setExpandedId(expandedId === entry.id ? null : entry.id)}
                >
                  <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${CATEGORY_COLORS[entry.category]}`}>
                    {getCategoryLabel(entry.category, t)}
                  </span>
                  <span className="text-[13px] text-[var(--abu-text-primary)] flex-1 truncate">
                    {entry.summary}
                  </span>
                  <span className="text-[11px] text-[var(--abu-text-placeholder)] whitespace-nowrap">
                    {formatAge(entry.updatedAt)}
                  </span>
                  {expandedId === entry.id ? (
                    <ChevronUp className="h-3.5 w-3.5 text-[var(--abu-text-placeholder)]" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5 text-[var(--abu-text-placeholder)]" />
                  )}
                </div>

                {expandedId === entry.id && (
                  <div className="px-3 pb-3 border-t border-[var(--abu-bg-active)]">
                    <p className="text-[12px] text-[var(--abu-text-tertiary)] leading-relaxed mt-2 whitespace-pre-wrap">
                      {entry.content}
                    </p>
                    {entry.keywords.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {entry.keywords.map((kw, i) => (
                          <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--abu-bg-muted)] text-[var(--abu-text-muted)]">
                            {kw}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="flex items-center justify-between mt-2 pt-2 border-t border-[var(--abu-bg-muted)]">
                      <span className="text-[10px] text-[var(--abu-text-placeholder)]">
                        {entry.sourceType === 'auto_flush' ? t.memory.sourceAutoFlush : entry.sourceType === 'agent_explicit' ? t.memory.sourceAgentExplicit : t.memory.sourceUserManual}
                        {' · '}
                        {format(t.memory.recallCount, { count: String(entry.accessCount) })}
                      </span>
                      <button
                        onClick={(e) => { e.stopPropagation(); setDeleteTarget(entry); }}
                        className="p-1 rounded text-[var(--abu-text-placeholder)] hover:text-red-500 hover:bg-red-50 transition-colors"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : legacyContent ? (
          <div className="space-y-2">
            <div className="text-[12px] text-[var(--abu-text-placeholder)]">
              {t.memory.legacyHint}
            </div>
            <div className="px-3 py-3 rounded-lg border border-[var(--abu-border)] text-[13px] text-[var(--abu-text-tertiary)] bg-[var(--abu-bg-muted)] font-mono leading-relaxed whitespace-pre-wrap">
              {legacyContent}
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <p className="text-[13px] text-[var(--abu-text-placeholder)]">
              {t.panel.memoryEmpty}
            </p>
            <p className="text-[12px] text-[var(--abu-text-placeholder)] mt-1">
              {t.memory.emptyHint}
            </p>
          </div>
        )}
      </div>
    </>
  );
}
