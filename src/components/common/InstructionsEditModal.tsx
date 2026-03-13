import { useState, useEffect } from 'react';
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

  useEffect(() => {
    if (!open) return;
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

  if (!open) return null;

  const handleSave = async () => {
    setSaving(true);
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
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 animate-in fade-in duration-150"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white rounded-2xl shadow-xl w-[480px] max-h-[80vh] flex flex-col p-6 animate-in zoom-in-95 duration-150">
        <h3 className="text-[16px] font-semibold text-[#29261b] mb-1">
          {t.panel.instructionsTitle}
        </h3>
        <p className="text-[13px] text-[#888579] mb-4">
          {t.panel.instructionsDesc}
        </p>

        {loading ? (
          <div className="flex-1 flex items-center justify-center py-12">
            <div className="w-5 h-5 border-2 border-[#d97757] border-t-transparent rounded-full animate-spin" />
          </div>
        ) : (
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={t.panel.instructionsPlaceholder}
            className="flex-1 min-h-[280px] max-h-[50vh] w-full px-3 py-3 rounded-lg border border-[#e8e4dd] text-[13px] text-[#29261b] bg-[#faf9f5] focus:outline-none focus:border-[#d97757] transition-colors resize-none font-mono leading-relaxed"
          />
        )}

        <div className="flex gap-3 mt-4">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 rounded-lg text-[13px] font-medium bg-[#f5f3ee] text-[#3d3929] hover:bg-[#e8e5de] transition-colors"
          >
            {t.common.cancel}
          </button>
          <button
            onClick={handleSave}
            disabled={saving || loading}
            className="flex-1 py-2.5 rounded-lg text-[14px] font-medium bg-[#d97757] text-white hover:bg-[#c4684a] transition-colors disabled:opacity-50"
          >
            {saving ? t.panel.instructionsSaving : t.common.save}
          </button>
        </div>
      </div>
    </div>
  );
}
