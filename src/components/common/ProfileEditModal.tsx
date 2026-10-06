import { useId, useLayoutEffect, useRef, useState, type ChangeEvent } from 'react';
import DefaultUserAvatar from '@/components/common/DefaultUserAvatar';
import { Button } from '@/components/ds/button';
import { Dialog, DialogClose } from '@/components/ds/dialog';
import { HiddenFileInput } from '@/components/ds/file-input';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { Pressable } from '@/components/ds/pressable';
import { TextField } from '@/components/ds/text-field';
import { Tooltip } from '@/components/ds/tooltip';
import { useI18n } from '@/i18n';
import { useSettingsStore } from '@/stores/settingsStore';

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
  const nicknameId = useId();
  // The picture file that is being read for this opening. A read takes a moment, and its
  // result belongs to the opening it was started in: closing the window drops it.
  const reading = useRef<FileReader | null>(null);
  const [isReading, setIsReading] = useState(false);

  // The form is filled with the saved values each time the window opens, and keeps what it
  // showed while it fades out.
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setNickname(userNickname);
      setAvatar(userAvatar);
    } else {
      setIsReading(false);
    }
  }
  useLayoutEffect(() => {
    if (!open) reading.current = null;
  }, [open]);

  const handleSave = () => {
    // The window keeps rendering while it fades out: nothing is saved then.
    if (!open) return;
    setUserNickname(nickname.trim());
    setUserAvatar(avatar);
    onClose();
  };

  const handleAvatarChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reading.current = reader;
    setIsReading(true);
    // True for the read that is under way; false for an earlier opening's read, or one a newer
    // choice has replaced. The read is over either way it ends.
    const end = () => {
      if (reading.current !== reader) return false;
      reading.current = null;
      setIsReading(false);
      return true;
    };
    reader.onload = () => {
      if (end() && typeof reader.result === 'string') setAvatar(reader.result);
    };
    // A picture that could not be read leaves the picture as it was.
    reader.onerror = () => { end(); };
    reader.onabort = () => { end(); };
    reader.readAsDataURL(file);
  };

  const isModified = avatar !== '' || nickname !== '';

  const handleReset = () => {
    setAvatar('');
    setNickname('');
  };

  const chooseFile = () => fileInputRef.current?.click();

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!next) onClose(); }}
      title={t.sidebar.editProfile}
      size="sm"
      closeButton
      dirty={nickname !== userNickname || avatar !== userAvatar}
      // Closing the window would drop the picture that is being read.
      busy={isReading}
      footer={(
        <>
          <DialogClose asChild><Button variant="plain">{t.common.cancel}</Button></DialogClose>
          <Button variant="primary" onClick={handleSave}>{t.common.save}</Button>
        </>
      )}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col items-center gap-2">
          <Tooltip content={t.sidebar.changeAvatar}>
            <Pressable aria-label={t.sidebar.changeAvatar} onClick={chooseFile} className="relative rounded-full">
              <span className="block size-16 overflow-hidden rounded-full">
                {avatar ? (
                  <img src={avatar} alt="Avatar" className="size-full object-cover" />
                ) : (
                  <DefaultUserAvatar />
                )}
              </span>
              <span className="absolute bottom-0 right-0 flex rounded-full bg-raised p-1 text-label-secondary shadow-float">
                <Icon icon={AppIcons.camera} size="sm" />
              </span>
            </Pressable>
          </Tooltip>
          <HiddenFileInput ref={fileInputRef} accept="image/*" onChange={handleAvatarChange} />
          <Button variant="plain" size="sm" onClick={chooseFile}>{t.sidebar.changeAvatar}</Button>
        </div>

        <div>
          <label htmlFor={nicknameId} className="mb-1 block text-ui-sm font-medium text-label-secondary">
            {t.sidebar.nickname}
          </label>
          <TextField
            id={nicknameId}
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            placeholder={t.sidebar.nicknamePlaceholder}
            maxLength={20}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSave();
            }}
          />
        </div>

        {isModified && (
          <div>
            <Button variant="plain" size="sm" onClick={handleReset}>{t.sidebar.resetProfile}</Button>
          </div>
        )}
      </div>
    </Dialog>
  );
}
