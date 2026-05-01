import { useState, useEffect, useCallback, useRef } from 'react';
import { useI18n } from '@/i18n';
import { loadSoul, saveSoul, getDefaultSoulTemplate } from '@/core/agent/soulConfig';
import { Textarea } from '@/components/ui/textarea';
import ConfirmDialog from '@/components/common/ConfirmDialog';
import ProactivityPicker from './ProactivityPicker';

type SaveStatus = 'idle' | 'saving' | 'saved';

export default function SoulSection() {
  const { t } = useI18n();
  const defaultTemplate = getDefaultSoulTemplate();
  const [content, setContent] = useState(defaultTemplate);
  const [loading, setLoading] = useState(true);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [showRestoreConfirm, setShowRestoreConfirm] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const contentRef = useRef(content);
  useEffect(() => {
    contentRef.current = content;
  }, [content]);
  const lastSavedRef = useRef('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const soul = await loadSoul();
      const text = soul || defaultTemplate;
      setContent(text);
      lastSavedRef.current = soul || '';
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [defaultTemplate]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, []);

  const doSave = useCallback(async (text: string) => {
    setSaveStatus('saving');
    try {
      await saveSoul(text);
      lastSavedRef.current = text;
      setSaveStatus('saved');
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setSaveStatus('idle'), 2000);
    } catch (err) {
      console.error('Failed to save soul:', err);
      setSaveStatus('idle');
    }
  }, []);

  const handleChange = (value: string) => {
    setContent(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      if (contentRef.current !== lastSavedRef.current) {
        doSave(contentRef.current);
      }
    }, 800);
  };

  const handleRestore = async () => {
    setShowRestoreConfirm(false);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setContent(defaultTemplate);
    setSaveStatus('saving');
    try {
      await saveSoul('');
      lastSavedRef.current = '';
      setSaveStatus('saved');
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setSaveStatus('idle'), 2000);
    } catch (err) {
      console.error('Failed to restore soul:', err);
      setSaveStatus('idle');
    }
  };

  const isModified = content !== defaultTemplate;

  const statusLabel = saveStatus === 'saving' ? t.soul.saving
    : saveStatus === 'saved' ? t.soul.saved
    : null;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="w-5 h-5 border-2 border-[var(--abu-clay)] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-[15px] font-semibold text-[var(--abu-text-primary)]">
          {t.soul.title}
        </h3>
        <p className="text-[13px] text-[var(--abu-text-muted)] mt-1">
          {t.soul.subtitle}
        </p>
      </div>

      {/* Proactivity preset — permanent home for the shy / companion /
          butler selector. SkillDraftsPanel has a one-time onboarding
          flow for first-draft users, but this is where they switch later. */}
      <ProactivityPicker />

      <div className="space-y-3">
        <div className="relative">
          <Textarea
            value={content}
            onChange={(e) => handleChange(e.target.value)}
            className="font-mono text-[13px] leading-relaxed min-h-[300px] resize-y"
            placeholder={t.soul.placeholder}
          />
          <div className="absolute bottom-2 right-3 flex items-center gap-2 text-[11px]">
            {statusLabel && (
              <span className="text-[var(--abu-text-placeholder)] transition-opacity duration-200">
                {statusLabel}
              </span>
            )}
            <span className={content.length > 2000 ? 'text-red-500' : 'text-[var(--abu-text-placeholder)]'}>
              {content.length} / 2000
            </span>
          </div>
        </div>

        <div className="flex items-center justify-between">
          <p className="text-[11px] text-[var(--abu-text-placeholder)]">
            {t.soul.filePath}
          </p>
          {isModified && (
            <button
              onClick={() => setShowRestoreConfirm(true)}
              className="text-[12px] text-[var(--abu-text-placeholder)] hover:text-[var(--abu-text-tertiary)] underline underline-offset-2 transition-colors"
            >
              {t.soul.restore}
            </button>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={showRestoreConfirm}
        title={t.soul.restoreConfirmTitle}
        message={t.soul.restoreConfirmMessage}
        confirmText={t.common.confirm}
        cancelText={t.common.cancel}
        onConfirm={handleRestore}
        onCancel={() => setShowRestoreConfirm(false)}
        variant="danger"
      />
    </div>
  );
}
