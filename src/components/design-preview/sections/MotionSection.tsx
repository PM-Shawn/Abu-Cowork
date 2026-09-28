import { useState } from 'react';
import { Button } from '@/components/ds/button';
import { cn } from '@/lib/utils';
import { Section } from './Section';

const DURATIONS = [
  ['fast · 120ms', 'duration-fast'],
  ['base · 200ms', 'duration-base'],
  ['slow · 300ms', 'duration-slow'],
] as const;

export function MotionSection() {
  const [run, setRun] = useState(0);
  return (
    <Section id="motion" title="Motion">
      <Button onClick={() => setRun((count) => count + 1)}>Play</Button>
      <div className="mt-3 flex gap-4">
        {DURATIONS.map(([label, duration]) => (
          <div
            key={`${label}-${run}`}
            data-ds-motion
            className={cn('flex h-16 w-32 items-center justify-center rounded-panel bg-raised text-ui-sm text-label-secondary shadow-float animate-in fade-in-0 zoom-in-97 ease-enter', duration)}
          >
            {label}
          </div>
        ))}
      </div>
    </Section>
  );
}
