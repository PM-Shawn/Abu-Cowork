import { useToastStore } from '@/stores/toastStore';
import { X, CheckCircle, AlertCircle, Info, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';

const iconMap = {
  success: CheckCircle,
  error: AlertCircle,
  info: Info,
  warning: AlertTriangle,
};

const colorMap = {
  success: {
    bg: 'bg-[var(--abu-success-bg)] border-[var(--abu-success)]',
    icon: 'text-[var(--abu-success)]',
    title: 'text-[var(--abu-success)]',
    message: 'text-[var(--abu-success)]',
    action: 'bg-[var(--abu-success-solid)] hover:opacity-90 text-white',
  },
  error: {
    bg: 'bg-[var(--abu-danger-bg)] border-[var(--abu-danger)]',
    icon: 'text-[var(--abu-danger)]',
    title: 'text-[var(--abu-danger)]',
    message: 'text-[var(--abu-danger)]',
    action: 'bg-[var(--abu-danger-solid)] hover:opacity-90 text-white',
  },
  info: {
    bg: 'bg-[var(--abu-info-bg)] border-[var(--abu-info)]',
    icon: 'text-[var(--abu-info)]',
    title: 'text-[var(--abu-info)]',
    message: 'text-[var(--abu-info)]',
    action: 'bg-[var(--abu-info-solid)] hover:opacity-90 text-white',
  },
  warning: {
    bg: 'bg-[var(--abu-warning-bg)] border-[var(--abu-warning)]',
    icon: 'text-[var(--abu-warning)]',
    title: 'text-[var(--abu-warning)]',
    message: 'text-[var(--abu-warning)]',
    action: 'bg-[var(--abu-warning-solid)] hover:opacity-90 text-white',
  },
};

export default function ToastContainer() {
  const { toasts, removeToast } = useToastStore();

  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none" aria-live="polite" role="status">
      {toasts.map((toast) => {
        const Icon = iconMap[toast.type];
        const colors = colorMap[toast.type];

        return (
          <div
            key={toast.id}
            className={cn(
              'pointer-events-auto flex items-start gap-2.5 px-4 py-3 rounded-xl border shadow-lg max-w-[360px] animate-in slide-in-from-right-5 fade-in duration-200',
              colors.bg
            )}
          >
            <Icon className={cn('h-4 w-4 mt-0.5 shrink-0', colors.icon)} />
            <div className="flex-1 min-w-0">
              <p className={cn('text-body font-medium', colors.title)}>
                {toast.title}
              </p>
              {toast.message && (
                <p className={cn('text-minor mt-0.5', colors.message)}>
                  {toast.message}
                </p>
              )}
              {toast.actions && toast.actions.length > 0 && (
                <div className="flex gap-1.5 mt-2">
                  {toast.actions.map((action, i) => (
                    <button
                      key={i}
                      onClick={() => {
                        action.onClick();
                        removeToast(toast.id);
                      }}
                      className={cn(
                        'px-2.5 py-1 text-caption font-medium rounded-md transition-colors',
                        i === 0 ? colors.action : 'bg-black/5 dark:bg-white/10 hover:bg-black/10 dark:hover:bg-white/15 text-gray-700 dark:text-[var(--abu-text-secondary)]',
                      )}
                    >
                      {action.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button
              onClick={() => removeToast(toast.id)}
              className={cn('p-0.5 rounded hover:bg-black/5 shrink-0', colors.icon)}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
