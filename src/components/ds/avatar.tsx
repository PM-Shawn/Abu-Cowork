import { Avatar as AvatarPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';

const SIZE = { sm: 'h-5 w-5 text-caption', md: 'h-7 w-7 text-ui-sm', lg: 'h-9 w-9 text-ui' } as const;

// A user's picture, or the first character of the name on the neutral fill.
export function Avatar({ name, src, size = 'md' }: { name: string; src?: string; size?: keyof typeof SIZE }) {
  return (
    <AvatarPrimitive.Root className={cn('inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full font-medium', SIZE[size])}>
      {src && <AvatarPrimitive.Image src={src} alt={name} className="h-full w-full object-cover" />}
      {/* The fill is the no-photo background only; a transparent photo shows nothing behind it. */}
      <AvatarPrimitive.Fallback role="img" aria-label={name} className="flex h-full w-full items-center justify-center bg-fill text-label-secondary">
        {Array.from(name)[0]?.toUpperCase() ?? ''}
      </AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  );
}
