import { cn } from '@/lib/utils';
import { Icon, type IconSize } from './icon';
import { AppIcons } from './icons';

const LABEL_SIZE = { ui: 'text-ui', 'ui-sm': 'text-ui-sm' } as const;

// One spinner per area, always with words that say what is happening. Under reduced
// motion tokens.css stops [data-ds-spinner], leaving a still icon and the words.
// The words carry the text size: the small spinner sits beside 12px text (a Tag, a small button),
// so its words are that size. Where it trades places with 13px words in one slot (a menu item's
// name, a notice, a status row), `labelSize="ui"` keeps that size beside the small icon.
export function Spinner({ label, size = 'md', labelHidden = false, labelSize }: {
  label: string;
  size?: IconSize;
  labelHidden?: boolean;
  labelSize?: keyof typeof LABEL_SIZE;
}) {
  const words = LABEL_SIZE[labelSize ?? (size === 'sm' ? 'ui-sm' : 'ui')];
  return (
    <span role="status" className="inline-flex items-center gap-2 text-label-secondary">
      <span data-ds-spinner className="inline-flex animate-spin">
        <Icon icon={AppIcons.loading} size={size} />
      </span>
      <span className={cn(words, labelHidden && 'sr-only')}>{label}</span>
    </span>
  );
}
