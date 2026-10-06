import { memo, useMemo } from 'react';
import { Toaster } from '@/components/ds/toaster';
import { useToastStore } from '@/stores/toastStore';

// The app's notification list. No props and store selectors, so it renders only when the
// notifications or the number of places change, not with the page around it. The store keeps
// every notification; the ones on screen are the newest, as many as there are places.
export default memo(function ToasterMount() {
  const toasts = useToastStore((s) => s.toasts);
  const places = useToastStore((s) => s.places);
  const removeToast = useToastStore((s) => s.removeToast);
  const shown = useMemo(() => toasts.slice(-places), [toasts, places]);
  return <Toaster toasts={shown} onDismiss={removeToast} />;
});
