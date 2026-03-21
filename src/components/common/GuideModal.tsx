import { useEffect } from 'react';
import { useI18n } from '@/i18n';

interface GuideModalProps {
  open: boolean;
  onClose: () => void;
}

export default function GuideModal({ open, onClose }: GuideModalProps) {
  const { t } = useI18n();

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const steps = [
    { title: t.guide.step1Title, desc: t.guide.step1Desc },
    { title: t.guide.step2Title, desc: t.guide.step2Desc },
    { title: t.guide.step3Title, desc: t.guide.step3Desc },
    { title: t.guide.step4Title, desc: t.guide.step4Desc },
  ];

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 animate-in fade-in duration-150"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white rounded-2xl shadow-xl w-[420px] p-6 animate-in zoom-in-95 duration-150">
        <h3 className="text-[16px] font-semibold text-[var(--abu-text-primary)] mb-5">
          {t.guide.title}
        </h3>

        <div className="space-y-4 mb-6">
          {steps.map((step, i) => (
            <div key={i} className="flex items-start gap-3">
              <span className="w-7 h-7 rounded-full bg-[var(--abu-clay)] text-white text-[13px] font-semibold flex items-center justify-center shrink-0 mt-0.5">
                {i + 1}
              </span>
              <div>
                <div className="text-[14px] font-medium text-[var(--abu-text-primary)]">{step.title}</div>
                <div className="text-[13px] text-[var(--abu-text-tertiary)] mt-0.5">{step.desc}</div>
              </div>
            </div>
          ))}
        </div>

        <button
          onClick={onClose}
          className="w-full py-2.5 rounded-lg text-[14px] font-medium bg-[var(--abu-clay)] text-white hover:bg-[var(--abu-clay-hover)] transition-colors"
        >
          {t.guide.dismiss}
        </button>
      </div>
    </div>
  );
}
