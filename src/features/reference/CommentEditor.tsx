// src/features/reference/CommentEditor.tsx
import { useState, useRef, useEffect, useCallback } from 'react';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/i18n';

const MAX = 500;

export function CommentEditor({ onSubmit, onCancel }: { onSubmit: (v: string) => void; onCancel: () => void }) {
  const { t } = useI18n();
  const [value, setValue] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);

  const submit = useCallback(() => {
    const v = value.trim();
    if (v && value.length <= MAX) onSubmit(v);
  }, [value, onSubmit]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
    else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
  };

  const over = value.length > MAX;
  return (
    <div className="w-72 rounded-xl border border-[var(--abu-border-subtle)] bg-[var(--abu-bg-elevated)] p-2 shadow-lg">
      <Textarea
        ref={ref}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={t.reference.commentPlaceholder}
        rows={2}
        className="resize-none border-0 focus-visible:ring-0"
        aria-label={t.reference.commentPlaceholder}
      />
      {over && (
        <div className="px-1 text-[11px] text-red-500">{value.length}/{MAX}</div>
      )}
    </div>
  );
}
