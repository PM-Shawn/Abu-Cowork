import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export type IconSize = 'sm' | 'md' | 'lg';

const SIZE_PX: Record<IconSize, number> = { sm: 14, md: 16, lg: 20 };

// The only way to render an icon outside src/components/ds/. Size is limited to
// three steps and the stroke is fixed at 1.5 so icons match 13px UI text weight.
export function Icon({
  icon: Glyph,
  size = 'md',
  label,
  className,
}: {
  icon: LucideIcon;
  size?: IconSize;
  label?: string;
  className?: string;
}) {
  const px = SIZE_PX[size];
  return (
    <Glyph
      width={px}
      height={px}
      strokeWidth={1.5}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
      className={cn('shrink-0', className)}
    />
  );
}
