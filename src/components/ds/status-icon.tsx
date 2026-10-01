import { cn } from '@/lib/utils';
import { Icon, type IconSize } from './icon';
import { AppIcons } from './icons';

export type StatusTone = 'success' | 'warning' | 'danger' | 'info';

const GLYPH = { success: AppIcons.success, warning: AppIcons.warning, danger: AppIcons.error, info: AppIcons.info } as const;
const COLOR = { success: 'text-success', warning: 'text-warning', danger: 'text-danger', info: 'text-info' } as const;

// Status color always comes with its shape: check, exclamation, cross, or "i".
export function StatusIcon({ tone, label, size = 'md' }: { tone: StatusTone; label?: string; size?: IconSize }) {
  return <Icon icon={GLYPH[tone]} size={size} label={label} className={cn(COLOR[tone])} />;
}
