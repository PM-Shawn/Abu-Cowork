import { useRef, useState } from 'react';
import { Button } from '@/components/ds/button';
import { Card } from '@/components/ds/card';
import { EmptyState } from '@/components/ds/empty-state';
import { AppIcons } from '@/components/ds/icons';
import { InlineMessage } from '@/components/ds/inline-message';
import { LoadError } from '@/components/ds/load-error';
import type { StatusTone } from '@/components/ds/status-icon';
import { Toaster } from '@/components/ds/toaster';
import type { Toast } from '@/stores/toastStore';
import { Section } from './Section';

const MESSAGES: Record<StatusTone, string> = {
  success: 'Settings saved.',
  warning: 'This key expires in 3 days.',
  danger: 'The key was rejected. Check that it starts with sk-.',
  info: 'Changes apply to new tasks.',
};
const TOAST_TYPES: Toast['type'][] = ['success', 'info', 'warning', 'error'];
const PREVIEW_TOAST_MS = 4000;

export function FeedbackSection() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counter = useRef(0);

  const dismiss = (id: string) => setToasts((list) => list.filter((toast) => toast.id !== id));
  const show = (type: Toast['type']) => {
    counter.current += 1;
    const id = `preview-${counter.current}`;
    const actions = type === 'info' ? [{ label: 'Undo', onClick: () => undefined }] : undefined;
    setToasts((list) => [...list, { id, type, title: `${type} notification ${counter.current}`, message: 'Disappears after 4 seconds.', actions }]);
    window.setTimeout(() => dismiss(id), PREVIEW_TOAST_MS);
  };

  return (
    <Section id="feedback" title="Status and notifications">
      <div className="grid grid-cols-2 gap-4">
        <Card>
          <EmptyState icon={AppIcons.folder} title="No files yet" description="Files the task creates show up here." action={<Button icon={AppIcons.add}>Add a file</Button>} />
        </Card>
        <Card>
          <LoadError reason="This task's record could not be read." onRetry={() => undefined} />
        </Card>
        <div className="flex flex-col gap-2">
          {(Object.keys(MESSAGES) as StatusTone[]).map((tone) => <InlineMessage key={tone} tone={tone}>{MESSAGES[tone]}</InlineMessage>)}
        </div>
        <div className="flex flex-wrap items-start gap-2">
          {TOAST_TYPES.map((type) => <Button key={type} onClick={() => show(type)}>{`Show ${type}`}</Button>)}
        </div>
      </div>
      <Toaster toasts={toasts} onDismiss={dismiss} />
    </Section>
  );
}
