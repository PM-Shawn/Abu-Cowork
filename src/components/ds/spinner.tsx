import { cn } from '@/lib/utils';
import { Icon, type IconSize } from './icon';
import { AppIcons } from './icons';

// One spinner per area, always with words that say what is happening. Under reduced
// motion tokens.css stops [data-ds-spinner], leaving a still icon and the words.
export function Spinner({ label, size = 'md', labelHidden = false }: { label: string; size?: IconSize; labelHidden?: boolean }) {
  return (
    <span role="status" className="inline-flex items-center gap-2 text-ui text-label-secondary">
      <span data-ds-spinner className="inline-flex animate-spin">
        <Icon icon={AppIcons.loading} size={size} />
      </span>
      <span className={cn(labelHidden && 'sr-only')}>{label}</span>
    </span>
  );
}
