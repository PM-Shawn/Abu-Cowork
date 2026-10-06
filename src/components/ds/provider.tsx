import { Tooltip as TooltipPrimitive } from 'radix-ui';
import { useEffect, type ReactNode } from 'react';
import { ConfirmProvider } from './confirm-provider';
import { trackInputModality } from './input-modality';
import { LayerProvider } from './layer';

// Everything the design-system components need above them. The app mounts it once at
// the root (from the first batch that uses these components); the design preview
// mounts its own with its host node as the portal container.
// `onModalChange` hears whether a dialog or a question is open, `onApprovalChange` whether an
// approval is shown (see LayerProvider).
export function DesignSystemProvider({ children, container, onModalChange, onApprovalChange }: {
  children: ReactNode;
  container?: HTMLElement | null;
  onModalChange?: (open: boolean) => void;
  onApprovalChange?: (shown: boolean) => void;
}) {
  // Dialogs read it to open without a focus ring after a pointer press.
  useEffect(() => trackInputModality(), []);
  return (
    <TooltipPrimitive.Provider delayDuration={500} skipDelayDuration={300}>
      <LayerProvider container={container} onModalChange={onModalChange} onApprovalChange={onApprovalChange}>
        <ConfirmProvider>{children}</ConfirmProvider>
      </LayerProvider>
    </TooltipPrimitive.Provider>
  );
}
