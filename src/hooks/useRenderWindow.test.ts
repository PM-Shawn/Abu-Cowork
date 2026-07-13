import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRenderWindow, RENDER_WINDOW } from './useRenderWindow';

describe('useRenderWindow', () => {
  it('starts with renderLimit = RENDER_WINDOW and no sentinel when everything fits', () => {
    const { result } = renderHook(() => useRenderWindow(10, 'conv-1'));
    expect(result.current.renderLimit).toBe(RENDER_WINDOW);
    expect(result.current.showSentinel).toBe(false);
  });

  it('shows the sentinel once totalGroups exceeds renderLimit', () => {
    const { result } = renderHook(() => useRenderWindow(RENDER_WINDOW + 5, 'conv-1'));
    expect(result.current.showSentinel).toBe(true);
  });

  it('loadEarlier grows the window by RENDER_WINDOW and can hide the sentinel again', () => {
    const total = RENDER_WINDOW + 5;
    const { result } = renderHook(() => useRenderWindow(total, 'conv-1'));
    expect(result.current.showSentinel).toBe(true);

    act(() => {
      result.current.loadEarlier();
    });

    expect(result.current.renderLimit).toBe(RENDER_WINDOW * 2);
    expect(result.current.showSentinel).toBe(false);
  });

  it('resets renderLimit back to RENDER_WINDOW when the active conversation changes', () => {
    const total = RENDER_WINDOW * 3;
    const { result, rerender } = renderHook(
      ({ convId }) => useRenderWindow(total, convId),
      { initialProps: { convId: 'conv-1' } },
    );

    act(() => {
      result.current.loadEarlier();
    });
    expect(result.current.renderLimit).toBe(RENDER_WINDOW * 2);

    rerender({ convId: 'conv-2' });
    expect(result.current.renderLimit).toBe(RENDER_WINDOW);
  });

  it('does not reset renderLimit on re-render with the same conversation id', () => {
    const total = RENDER_WINDOW * 3;
    const { result, rerender } = renderHook(
      ({ convId }) => useRenderWindow(total, convId),
      { initialProps: { convId: 'conv-1' } },
    );

    act(() => {
      result.current.loadEarlier();
    });
    expect(result.current.renderLimit).toBe(RENDER_WINDOW * 2);

    rerender({ convId: 'conv-1' });
    expect(result.current.renderLimit).toBe(RENDER_WINDOW * 2);
  });
});
