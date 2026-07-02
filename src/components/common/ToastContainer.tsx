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
    bg: 'bg-green-50 dark:bg-green-950/80 border-green-200 dark:border-green-900',
    icon: 'text-green-500 dark:text-green-400',
    title: 'text-green-800 dark:text-green-300',
    message: 'text-green-600 dark:text-green-400',
    action: 'bg-green-600 hover:bg-green-700 text-white',
  },
  error: {
    bg: 'bg-red-50 dark:bg-red-950/80 border-red-200 dark:border-red-900',
    icon: 'text-red-500 dark:text-red-400',
    title: 'text-red-800 dark:text-red-300',
    message: 'text-red-600 dark:text-red-400',
    action: 'bg-red-600 hover:bg-red-700 text-white',
  },
  info: {
    bg: 'bg-blue-50 dark:bg-blue-950/80 border-blue-200 dark:border-blue-900',
    icon: 'text-blue-500 dark:text-blue-400',
    title: 'text-blue-800 dark:text-blue-300',
    message: 'text-blue-600 dark:text-blue-400',
    action: 'bg-blue-600 hover:bg-blue-700 text-white',
  },
  warning: {
    bg: 'bg-amber-50 dark:bg-amber-950/80 border-amber-200 dark:border-amber-900',
    icon: 'text-amber-500 dark:text-amber-400',
    title: 'text-amber-800 dark:text-amber-300',
    message: 'text-amber-600 dark:text-amber-400',
    action: 'bg-amber-600 hover:bg-amber-700 text-white',
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
              <p className={cn('text-[13px] font-medium', colors.title)}>
                {toast.title}
              </p>
              {toast.message && (
                <p className={cn('text-[12px] mt-0.5', colors.message)}>
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
                        'px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors',
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
