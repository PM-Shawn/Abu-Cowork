import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';
import { FOCUS_RING } from './styles';

export function Link({ className, ...props }: ComponentProps<'a'>) {
  return <a className={cn('rounded-control text-link underline-offset-2 hover:underline', FOCUS_RING, className)} {...props} />;
}
