import { useState, useEffect, useCallback, useRef } from 'react';
import { useI18n } from '@/i18n';
import { loadSoul, saveSoul, getDefaultSoulTemplate } from '@/core/agent/soulConfig';
import { Button } from '@/components/ds/button';
import { useConfirm } from '@/components/ds/confirm-context';
import { Spinner } from '@/components/ds/spinner';
import { TextArea } from '@/components/ds/text-area';
import SettingsSectionHeader from '@/components/settings/SettingsSectionHeader';
import { cn } from '@/lib/utils';
import ProactivityPicker from './ProactivityPicker';

type SaveStatus = 'idle' | 'saving' | 'saved';

export default function SoulSection() {
  const { t } = useI18n();
  const confirm = useConfirm();
  const defaultTemplate = getDefaultSoulTemplate();
  const [content, setContent] = useState(defaultTemplate);
  const [loading, setLoading] = useState(true);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');

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
    const confirmed = await confirm({
      title: t.soul.restoreConfirmTitle,
      message: t.soul.restoreConfirmMessage,
      confirmLabel: t.common.confirm,
      tone: 'danger',
    });
    if (!confirmed) return;
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
        <Spinner label={t.common.loading} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <SettingsSectionHeader title={t.soul.title} description={t.soul.subtitle} />

      {/* Proactivity preset — permanent home for the shy / companion /
          butler selector. SkillDraftsPanel has a one-time onboarding
          flow for first-draft users, but this is where they switch later. */}
      <ProactivityPicker />

      <div className="space-y-3">
        <div className="relative">
          <TextArea
            value={content}
            onChange={(e) => handleChange(e.target.value)}
            className="min-h-75 resize-y font-code"
            placeholder={t.soul.placeholder}
          />
          <div className="absolute bottom-2 right-3 flex items-center gap-2 text-ui-sm text-label-tertiary">
            {statusLabel && <span>{statusLabel}</span>}
            <span className={cn(content.length > 2000 && 'text-danger')}>
              {content.length} / 2000
            </span>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3">
          <p className="text-caption text-label-tertiary">
            {t.soul.filePath}
          </p>
          {isModified && (
            <Button variant="plain" size="sm" onClick={() => { void handleRestore(); }}>
              {t.soul.restore}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
