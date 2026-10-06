import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { cn } from '@/lib/utils';

// The placeholder picture of a user who has chosen none: the identity colours, as `ds/avatar` uses.
export default function DefaultUserAvatar({ className }: { className?: string }) {
  return (
    <div className={cn('flex size-full items-center justify-center bg-brand text-brand-ink', className)}>
      <Icon icon={AppIcons.account} size="lg" className="size-1/2" />
    </div>
  );
}
