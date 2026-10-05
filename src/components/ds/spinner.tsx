import { cn } from '@/lib/utils';
import { Icon, type IconSize } from './icon';
import { AppIcons } from './icons';

// One spinner per area, always with words that say what is happening. Under reduced
// motion tokens.css stops [data-ds-spinner], leaving a still icon and the words.
// The small one sits beside 12px text (a Tag, a row label), so its words are that size.
export function Spinner({ label, size = 'md', labelHidden = false }: { label: string; size?: IconSize; labelHidden?: boolean }) {
  return (
    <span role="status" className="inline-flex items-center gap-2 text-ui text-label-secondary">
      <span data-ds-spinner className="inline-flex animate-spin">
        <Icon icon={AppIcons.loading} size={size} />
      </span>
      <span className={cn(size === 'sm' ? 'text-ui-sm' : 'text-ui', labelHidden && 'sr-only')}>{label}</span>
    </span>
  );
}
