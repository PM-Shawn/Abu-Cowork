import { useState } from 'react';
import { IconButton } from '@/components/ds/button';
import { AppIcons } from '@/components/ds/icons';
import { TextField } from '@/components/ds/text-field';
import { useI18n } from '@/i18n';

// A key or password field: masked until the user asks to see it. The value never leaves the input.
export default function SecretField({ value, onChange, placeholder, disabled, id }: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
}) {
  const { t } = useI18n();
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <TextField
        id={id}
        type={shown ? 'text' : 'password'}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className="pr-8"
      />
      <span className="absolute inset-y-0 right-1 flex items-center">
        <IconButton
          size="sm"
          icon={shown ? AppIcons.hideSecret : AppIcons.showSecret}
          label={shown ? t.settings.secretHide : t.settings.secretShow}
          disabled={disabled}
          onClick={() => setShown(!shown)}
        />
      </span>
    </div>
  );
}
