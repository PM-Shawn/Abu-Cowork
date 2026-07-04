import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '@/i18n';
import { readTextFile, writeTextFile, exists, mkdir } from '@tauri-apps/plugin-fs';
import { joinPath } from '@/utils/pathUtils';

interface InstructionsEditModalProps {
  open: boolean;
  onClose: () => void;
  workspacePath: string;
}

export default function InstructionsEditModal({ open, onClose, workspacePath }: InstructionsEditModalProps) {
  const { t } = useI18n();
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    let cancelled = false;
    async function loadContent() {
      setLoading(true);
      try {
        const abuMdPath = joinPath(workspacePath, '.abu', 'ABU.md');
        const fileExists = await exists(abuMdPath);
        if (fileExists) {
          const text = await readTextFile(abuMdPath);
          if (!cancelled) setContent(text);
        } else {
          if (!cancelled) setContent('');
        }
      } catch {
        if (!cancelled) setContent('');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    loadContent();
    return () => { cancelled = true; };
  }, [open, workspacePath]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open || typeof document === 'undefined') return null;

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const abuDir = joinPath(workspacePath, '.abu');
      if (!(await exists(abuDir))) {
        await mkdir(abuDir, { recursive: true });
      }
      const abuMdPath = joinPath(abuDir, 'ABU.md');
      await writeTextFile(abuMdPath, content);
      onClose();
    } catch (err) {
      console.error('Failed to save instructions:', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 animate-in fade-in duration-150"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-[var(--abu-bg-base)] rounded-2xl shadow-xl w-[480px] flex flex-col p-6 animate-in zoom-in-95 duration-150">
        <h3 className="text-[16px] font-semibold text-[var(--abu-text-primary)] mb-1">
          {t.panel.instructionsTitle}
        </h3>
        <p className="text-[13px] text-[var(--abu-text-muted)] mb-4">
          {t.panel.instructionsDesc}
        </p>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="w-5 h-5 border-2 border-[var(--abu-clay)] border-t-transparent rounded-full animate-spin" />
          </div>
        ) : (
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={t.panel.instructionsPlaceholder}
            className="min-h-[280px] max-h-[50vh] w-full px-3 py-3 rounded-lg border border-[var(--abu-border)] text-[13px] text-[var(--abu-text-primary)] bg-[var(--abu-bg-base)] focus:outline-none focus:border-[var(--abu-clay)] transition-colors resize-none font-mono leading-relaxed"
          />
        )}

        {error && (
          <div
            role="alert"
            className="mt-3 px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-[12px] text-red-700 leading-relaxed break-words"
          >
            <div className="font-medium mb-0.5">{t.panel.instructionsSaveFailed}</div>
            <div className="text-red-600/90">{error}</div>
          </div>
        )}

        <div className="flex gap-3 mt-4">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 rounded-lg text-[13px] font-medium bg-[var(--abu-bg-muted)] text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-hover)] transition-colors"
          >
            {t.common.cancel}
          </button>
          <button
            onClick={handleSave}
            disabled={saving || loading}
            className="flex-1 py-2.5 rounded-lg text-[14px] font-medium bg-[var(--abu-clay)] text-white hover:bg-[var(--abu-clay-hover)] transition-colors disabled:opacity-50"
          >
            {saving ? t.panel.instructionsSaving : t.common.save}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
