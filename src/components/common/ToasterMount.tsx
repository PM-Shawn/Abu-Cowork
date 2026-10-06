import { memo } from 'react';
import { Toaster } from '@/components/ds/toaster';
import { useToastStore } from '@/stores/toastStore';

// The app's notification list. No props and two store selectors, so it renders only when the
// list of notifications changes, not with the page around it.
export default memo(function ToasterMount() {
  const toasts = useToastStore((s) => s.toasts);
  const removeToast = useToastStore((s) => s.removeToast);
  return <Toaster toasts={toasts} onDismiss={removeToast} />;
});
