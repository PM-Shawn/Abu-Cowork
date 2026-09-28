import { Tooltip as TooltipPrimitive } from 'radix-ui';
import type { ReactNode } from 'react';
import { LayerProvider } from './layer';

// Everything the design-system components need above them. The app mounts it once at
// the root (from the first batch that uses these components); the design preview
// mounts its own with its host node as the portal container.
export function DesignSystemProvider({ children, container }: { children: ReactNode; container?: HTMLElement | null }) {
  return (
    <TooltipPrimitive.Provider delayDuration={500} skipDelayDuration={300}>
      <LayerProvider container={container}>{children}</LayerProvider>
    </TooltipPrimitive.Provider>
  );
}
