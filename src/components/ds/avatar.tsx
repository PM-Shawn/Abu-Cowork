import { Avatar as AvatarPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';

const SIZE = { sm: 'h-5 w-5 text-caption', md: 'h-7 w-7 text-ui-sm', lg: 'h-9 w-9 text-ui' } as const;

// Identity only: the brand green appears here and on the app icon, nowhere else.
export function Avatar({ name, src, size = 'md' }: { name: string; src?: string; size?: keyof typeof SIZE }) {
  return (
    <AvatarPrimitive.Root className={cn('inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full font-medium', SIZE[size])}>
      {src && <AvatarPrimitive.Image src={src} alt={name} className="h-full w-full object-cover" />}
      {/* The green is the no-photo background only; a transparent photo shows nothing behind it. */}
      <AvatarPrimitive.Fallback role="img" aria-label={name} className="flex h-full w-full items-center justify-center bg-brand text-brand-ink">
        {Array.from(name)[0]?.toUpperCase() ?? ''}
      </AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  );
}
