import { useState, useEffect, useRef } from 'react';
import { useI18n } from '@/i18n';
import { useSettingsStore } from '@/stores/settingsStore';
import { Camera } from 'lucide-react';
import abuAvatar from '@/assets/abu-avatar.png';

interface ProfileEditModalProps {
  open: boolean;
  onClose: () => void;
}

export default function ProfileEditModal({ open, onClose }: ProfileEditModalProps) {
  const { t } = useI18n();
  const userNickname = useSettingsStore((s) => s.userNickname);
  const userAvatar = useSettingsStore((s) => s.userAvatar);
  const setUserNickname = useSettingsStore((s) => s.setUserNickname);
  const setUserAvatar = useSettingsStore((s) => s.setUserAvatar);

  const [nickname, setNickname] = useState(userNickname);
  const [avatar, setAvatar] = useState(userAvatar);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setNickname(userNickname);
      setAvatar(userAvatar);
    }
  }, [open, userNickname, userAvatar]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const handleSave = () => {
    setUserNickname(nickname.trim());
    setUserAvatar(avatar);
    onClose();
  };

  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setAvatar(reader.result);
      }
    };
    reader.readAsDataURL(file);
  };

  const displayAvatar = avatar || abuAvatar;
  const isModified = avatar !== '' || nickname !== '';

  const handleReset = () => {
    setAvatar('');
    setNickname('');
  };

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 animate-in fade-in duration-150"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white rounded-2xl shadow-xl w-[360px] p-6 animate-in zoom-in-95 duration-150">
        <h3 className="text-[16px] font-semibold text-[var(--abu-text-primary)] mb-5">
          {t.sidebar.editProfile}
        </h3>

        {/* Avatar */}
        <div className="flex flex-col items-center mb-5">
          <button
            onClick={() => fileInputRef.current?.click()}
            className="relative group"
          >
            <div className="w-16 h-16 rounded-full overflow-hidden">
              <img src={displayAvatar} alt="Avatar" className="w-full h-full object-cover" />
            </div>
            <div className="absolute inset-0 rounded-full bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
              <Camera className="h-5 w-5 text-white" />
            </div>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleAvatarChange}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="text-[12px] text-[var(--abu-clay)] mt-2 hover:underline"
          >
            {t.sidebar.changeAvatar}
          </button>
        </div>

        {/* Nickname */}
        <div className="mb-5">
          <label className="text-[13px] font-medium text-[var(--abu-text-secondary)] mb-1.5 block">
            {t.sidebar.nickname}
          </label>
          <input
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            placeholder={t.sidebar.nicknamePlaceholder}
            maxLength={20}
            className="w-full px-3 py-2 rounded-lg border border-[var(--abu-border)] text-[14px] text-[var(--abu-text-primary)] bg-[var(--abu-bg-base)] focus:outline-none focus:border-[var(--abu-clay)] transition-colors"
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSave();
            }}
          />
        </div>

        {/* Reset link */}
        {isModified && (
          <button
            onClick={handleReset}
            className="text-[12px] text-[var(--abu-text-tertiary)] hover:text-[var(--abu-clay)] mb-4 transition-colors"
          >
            {t.sidebar.resetProfile}
          </button>
        )}

        {/* Buttons */}
        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 rounded-lg text-[13px] font-medium bg-[var(--abu-bg-muted)] text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-hover)] transition-colors"
          >
            {t.common.cancel}
          </button>
          <button
            onClick={handleSave}
            className="flex-1 py-2.5 rounded-lg text-[14px] font-medium bg-[var(--abu-clay)] text-white hover:bg-[var(--abu-clay-hover)] transition-colors"
          >
            {t.common.save}
          </button>
        </div>
      </div>
    </div>
  );
}
