import { useState, useEffect } from 'react';
import { useI18n } from '@/i18n';
import {
  loadProjectMemory, saveProjectMemory, clearProjectMemory,
  loadAgentMemory, saveAgentMemory, clearAgentMemory,
} from '@/core/agent/agentMemory';
import ConfirmDialog from './ConfirmDialog';

interface ProjectMemoryProps {
  open: boolean;
  onClose: () => void;
  scope: 'project';
  workspacePath: string;
}

interface PersonalMemoryProps {
  open: boolean;
  onClose: () => void;
  scope: 'personal';
  workspacePath?: never;
}

type MemoryViewModalProps = ProjectMemoryProps | PersonalMemoryProps;

const MAIN_AGENT_NAME = 'abu';

export default function MemoryViewModal(props: MemoryViewModalProps) {
  const { open, onClose, scope } = props;
  const { t } = useI18n();
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  const isPersonal = scope === 'personal';

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const text = isPersonal
          ? await loadAgentMemory(MAIN_AGENT_NAME)
          : await loadProjectMemory(props.workspacePath);
        if (!cancelled) setContent(text);
      } catch {
        if (!cancelled) setContent('');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [open, isPersonal, isPersonal ? undefined : props.workspacePath]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const handleSave = async () => {
    setSaving(true);
    try {
      if (isPersonal) {
        await saveAgentMemory(MAIN_AGENT_NAME, content);
      } else {
        await saveProjectMemory(props.workspacePath, content);
      }
      onClose();
    } catch (err) {
      console.error('Failed to save memory:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    try {
      if (isPersonal) {
        await clearAgentMemory(MAIN_AGENT_NAME);
      } else {
        await clearProjectMemory(props.workspacePath);
      }
      setContent('');
      setShowClearConfirm(false);
    } catch (err) {
      console.error('Failed to clear memory:', err);
    }
  };

  const title = isPersonal ? t.sidebar.personalMemoryTitle : t.panel.memoryTitle;
  const desc = isPersonal ? t.sidebar.personalMemoryDesc : t.panel.memoryDesc;
  const placeholder = isPersonal ? t.sidebar.personalMemoryPlaceholder : t.panel.memoryPlaceholder;
  const accentColor = isPersonal ? '#d97757' : '#8b7ec8';

  return (
    <>
      <ConfirmDialog
        open={showClearConfirm}
        title={t.panel.memoryClearTitle}
        message={isPersonal ? t.sidebar.personalMemoryClearMessage : t.panel.memoryClearMessage}
        confirmText={t.panel.memoryClearConfirm}
        cancelText={t.common.cancel}
        onConfirm={handleClear}
        onCancel={() => setShowClearConfirm(false)}
        variant="danger"
      />

      <div
        className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 animate-in fade-in duration-150"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div className="bg-white rounded-2xl shadow-xl w-[480px] max-h-[80vh] flex flex-col p-6 animate-in zoom-in-95 duration-150">
          <h3 className="text-[16px] font-semibold text-[#29261b] mb-1">
            {title}
          </h3>
          <p className="text-[13px] text-[#888579] mb-4">
            {desc}
          </p>

          {loading ? (
            <div className="flex-1 flex items-center justify-center py-12">
              <div
                className="w-5 h-5 border-2 border-t-transparent rounded-full animate-spin"
                style={{ borderColor: accentColor, borderTopColor: 'transparent' }}
              />
            </div>
          ) : (
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder={placeholder}
              className="flex-1 min-h-[280px] max-h-[50vh] w-full px-3 py-3 rounded-lg border border-[#e8e4dd] text-[13px] text-[#29261b] bg-[#faf9f5] focus:outline-none transition-colors resize-none font-mono leading-relaxed"
              style={{ '--tw-ring-color': accentColor } as React.CSSProperties}
              onFocus={(e) => e.target.style.borderColor = accentColor}
              onBlur={(e) => e.target.style.borderColor = '#e8e4dd'}
            />
          )}

          <div className="flex gap-3 mt-4">
            {content.trim() && (
              <button
                onClick={() => setShowClearConfirm(true)}
                className="px-4 py-2.5 rounded-lg text-[13px] font-medium text-red-500 hover:bg-red-50 transition-colors"
              >
                {t.panel.memoryClear}
              </button>
            )}
            <div className="flex-1" />
            <button
              onClick={onClose}
              className="px-4 py-2.5 rounded-lg text-[13px] font-medium bg-[#f5f3ee] text-[#3d3929] hover:bg-[#e8e5de] transition-colors"
            >
              {t.common.cancel}
            </button>
            <button
              onClick={handleSave}
              disabled={saving || loading}
              className="px-4 py-2.5 rounded-lg text-[14px] font-medium bg-[#d97757] text-white hover:bg-[#c4684a] transition-colors disabled:opacity-50"
            >
              {saving ? t.panel.instructionsSaving : t.common.save}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
