import { useState, useEffect, useRef } from 'react';
import { useI18n } from '@/i18n';
import { HelpCircle } from 'lucide-react';
import {
  loadAgentMemory, saveAgentMemory, clearAgentMemory,
} from '@/core/agent/agentMemory';
import ConfirmDialog from '@/components/common/ConfirmDialog';

const MAIN_AGENT_NAME = 'abu';

export default function PersonalMemorySection() {
  const { t } = useI18n();
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [showTip, setShowTip] = useState(false);
  const tipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const text = await loadAgentMemory(MAIN_AGENT_NAME);
        if (!cancelled) {
          setContent(text);
          setDirty(false);
        }
      } catch {
        if (!cancelled) setContent('');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

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

  const handleSave = async () => {
    setSaving(true);
    try {
      await saveAgentMemory(MAIN_AGENT_NAME, content);
      setDirty(false);
    } catch (err) {
      console.error('Failed to save personal memory:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    try {
      await clearAgentMemory(MAIN_AGENT_NAME);
      setContent('');
      setDirty(false);
      setShowClearConfirm(false);
    } catch (err) {
      console.error('Failed to clear personal memory:', err);
    }
  };

  return (
    <>
      <ConfirmDialog
        open={showClearConfirm}
        title={t.panel.memoryClearTitle}
        message={t.sidebar.personalMemoryClearMessage}
        confirmText={t.panel.memoryClearConfirm}
        cancelText={t.common.cancel}
        onConfirm={handleClear}
        onCancel={() => setShowClearConfirm(false)}
        variant="danger"
      />

      <div className="space-y-4">
        <div>
          <div className="flex items-center gap-1.5 relative" ref={tipRef}>
            <h3 className="text-[15px] font-semibold text-[#29261b]">
              {t.sidebar.personalMemoryTitle}
            </h3>
            <button
              onClick={() => setShowTip(!showTip)}
              className="text-[#b0ada4] hover:text-[#888579] transition-colors"
            >
              <HelpCircle className="h-3.5 w-3.5" />
            </button>

            {showTip && (
              <div className="absolute top-full left-0 mt-2 w-[340px] p-4 bg-white rounded-xl shadow-lg border border-[#e8e4dd] z-50 animate-in fade-in slide-in-from-top-1 duration-150">
                <div className="space-y-2.5 text-[12px] text-[#656358] leading-relaxed">
                  <p className="text-[13px] text-[#3d3929] font-medium">{t.sidebar.memoryGuideTitle}</p>
                  <div className="space-y-1.5">
                    <p><span className="font-medium text-[#d97757]">{t.sidebar.memoryGuidePersonalName}</span> — {t.sidebar.memoryGuidePersonalDesc}</p>
                    <p><span className="font-medium text-[#8b7ec8]">{t.sidebar.memoryGuideProjectMemoryName}</span> — {t.sidebar.memoryGuideProjectMemoryDesc}</p>
                    <p><span className="font-medium text-[#3d3929]">{t.sidebar.memoryGuideProjectRulesName}</span> — {t.sidebar.memoryGuideProjectRulesDesc}</p>
                  </div>
                  <p className="text-[11px] text-[#888579] border-t border-[#f0ede6] pt-2">{t.sidebar.memoryGuideTip}</p>
                </div>
              </div>
            )}
          </div>
          <p className="text-[13px] text-[#888579] mt-1">
            {t.sidebar.personalMemoryDesc}
          </p>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <div className="w-5 h-5 border-2 border-[#d97757] border-t-transparent rounded-full animate-spin" />
          </div>
        ) : (
          <textarea
            value={content}
            onChange={(e) => { setContent(e.target.value); setDirty(true); }}
            placeholder={t.sidebar.personalMemoryPlaceholder}
            className="w-full min-h-[320px] px-3 py-3 rounded-lg border border-[#e8e4dd] text-[13px] text-[#29261b] bg-white focus:outline-none focus:border-[#d97757] transition-colors resize-none font-mono leading-relaxed"
          />
        )}

        <div className="flex items-center gap-3">
          {content.trim() && (
            <button
              onClick={() => setShowClearConfirm(true)}
              className="px-4 py-2 rounded-lg text-[13px] font-medium text-red-500 hover:bg-red-50 transition-colors"
            >
              {t.panel.memoryClear}
            </button>
          )}
          <div className="flex-1" />
          {dirty && (
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-5 py-2 rounded-lg text-[13px] font-medium bg-[#d97757] text-white hover:bg-[#c4684a] transition-colors disabled:opacity-50"
            >
              {saving ? t.panel.instructionsSaving : t.common.save}
            </button>
          )}
        </div>
      </div>
    </>
  );
}
