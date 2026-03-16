import { useState, useEffect } from 'react';
import { useI18n } from '@/i18n';
import { X, Minus } from 'lucide-react';

interface CloseDialogProps {
  open: boolean;
  onQuit: () => void;
  onMinimize: () => void;
  onCancel: () => void;
  onCloseActionChange: (action: 'ask' | 'minimize' | 'quit') => void;
}

export default function CloseDialog({
  open,
  onQuit,
  onMinimize,
  onCancel,
  onCloseActionChange,
}: CloseDialogProps) {
  const { t } = useI18n();
  const [remember, setRemember] = useState(false);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onCancel]);

  if (!open) return null;

  const handleQuit = () => {
    if (remember) onCloseActionChange('quit');
    onQuit();
  };

  const handleMinimize = () => {
    if (remember) onCloseActionChange('minimize');
    onMinimize();
  };

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 animate-in fade-in duration-150"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="relative bg-[#faf8f5] rounded-2xl shadow-2xl ring-1 ring-black/8 w-[400px] p-7 animate-in zoom-in-95 duration-150">
        <button
          onClick={onCancel}
          className="absolute top-4 right-4 p-1 rounded-md text-[#b0ad9f] hover:text-[#29261b] hover:bg-[#e8e5de] transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
        <h3 className="text-[16px] font-semibold text-[#29261b] mb-1.5">
          {t.windowClose.title}
        </h3>
        <p className="text-[13.5px] text-[#8a8578] leading-relaxed mb-5">
          {t.windowClose.message}
        </p>

        {/* Footer: checkbox left, buttons right */}
        <div className="flex items-center justify-between">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="w-3.5 h-3.5 rounded border-[#d5d1c9] text-[#d97757] focus:ring-[#d97757] accent-[#d97757]"
            />
            <span className="text-[12px] text-[#8a8578]">
              {t.windowClose.rememberChoice}
            </span>
          </label>
          <div className="flex items-center gap-2">
            <button
              onClick={handleMinimize}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-[13px] font-medium border border-[#e0ddd6] bg-white text-[#3d3929] hover:bg-[#f0ede6] transition-colors"
            >
              <Minus className="h-3.5 w-3.5" />
              {t.windowClose.minimize}
            </button>
            <button
              onClick={handleQuit}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-[13px] font-medium bg-[#d97757] text-white hover:bg-[#c96747] transition-colors"
            >
              <X className="h-3.5 w-3.5" />
              {t.windowClose.quit}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
