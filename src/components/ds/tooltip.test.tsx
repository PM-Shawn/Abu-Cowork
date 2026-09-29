// @vitest-environment happy-dom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Tooltip as TooltipPrimitive } from 'radix-ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Button } from './button';
import { DesignSystemProvider } from './provider';
import { Tooltip } from './tooltip';

describe('Tooltip', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('keeps the design-system delay when a faster legacy provider is nearer', () => {
    // App.tsx mounts the legacy TooltipProvider (200 ms) inside DesignSystemProvider.
    render(
      <DesignSystemProvider>
        <TooltipPrimitive.Provider delayDuration={200}>
          <Tooltip content="Copy code"><Button>Copy</Button></Tooltip>
        </TooltipPrimitive.Provider>
      </DesignSystemProvider>,
    );
    fireEvent.pointerMove(screen.getByRole('button', { name: 'Copy' }), { pointerType: 'mouse' });

    act(() => { vi.advanceTimersByTime(300); });
    expect(screen.queryByRole('tooltip')).toBeNull();

    act(() => { vi.advanceTimersByTime(200); });
    expect(screen.getByRole('tooltip').textContent).toBe('Copy code');
  });
});
