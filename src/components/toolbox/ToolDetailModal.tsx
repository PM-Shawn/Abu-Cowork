import type { ReactNode } from 'react';
import { Dialog } from '@/components/ds/dialog';
import { cn } from '@/lib/utils';

/**
 * Detail window of the toolbox card grid: a design-system dialog whose header
 * (avatar, name, subtitle, actions) stays put above the caller's scrolling content. Each tab injects
 * its own detail JSX so business state stays in the owning section.
 */
export interface ToolDetailModalProps {
  open: boolean;
  /** The dialog's accessible name; without it the string `title` is used. */
  ariaLabel?: string;
  testId?: string;
  onClose: () => void;
  avatar?: ReactNode;
  stackedHeader?: boolean;
  title?: ReactNode;
  subtitle?: ReactNode;
  /** Header-row actions to the left of the close button (toggle, menu, primary CTA). */
  headerActions?: ReactNode;
  /** Footer under the content (e.g. the primary CTA). */
  footer?: ReactNode;
  children: ReactNode;
  /** Width of the window: max-w-lg, max-w-2xl or max-w-4xl. */
  maxWidth?: string;
  /** Only its height class is used; it sets the height of the content area. */
  panelClassName?: string;
  /** Accepted for callers written before the layer registry; one dialog is open at a time, so it has no effect. */
  disableEscape?: boolean;
  /** Runs once the window has gone; `event.preventDefault()` there keeps the focus from returning to the control that opened it. */
  onCloseAutoFocus?: (event: Event) => void;
}

const SIZE: Record<string, 'md' | 'lg' | 'xl'> = { 'max-w-lg': 'md', 'max-w-2xl': 'lg', 'max-w-4xl': 'xl' };

const heightOf = (panelClassName?: string) => panelClassName?.split(/\s+/).find((name) => name.startsWith('h-'));

export default function ToolDetailModal({
  open,
  ariaLabel,
  testId,
  onClose,
  avatar,
  stackedHeader = false,
  title,
  subtitle,
  headerActions,
  footer,
  children,
  maxWidth = 'max-w-lg',
  panelClassName,
  disableEscape: _disableEscape,
  onCloseAutoFocus,
}: ToolDetailModalProps) {
  const name = ariaLabel ?? (typeof title === 'string' ? title : '');
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!next) onClose(); }}
      title={name}
      titleHidden
      size={SIZE[maxWidth] ?? 'lg'}
      closeButton
      contentProps={testId ? { 'data-testid': testId } : undefined}
      onCloseAutoFocus={onCloseAutoFocus}
      footer={footer}
      header={(
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-4">
            {avatar && (
              <div
                className={cn(
                  'flex shrink-0 select-none items-center justify-center text-title-lg',
                  stackedHeader ? 'size-11 rounded-full border border-separator' : 'size-14 rounded-panel bg-fill',
                )}
              >
                {avatar}
              </div>
            )}
            <div className="min-w-0 pt-1">
              {title && <div className="truncate text-title text-label">{title}</div>}
              {subtitle && <div className="mt-1 text-ui text-label-secondary">{subtitle}</div>}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">{headerActions}</div>
        </div>
      )}
    >
      <div className={heightOf(panelClassName)}>{children}</div>
    </Dialog>
  );
}
