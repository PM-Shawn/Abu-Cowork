/// <reference types="@testing-library/jest-dom" />
/**
 * Regression tests for the Checkbox primitive.
 *
 * Root cause of the "can't uncheck by clicking the box" bug: the checkbox is a
 * <button> that was rendered inside a <label>. In WKWebView (macOS Tauri) a
 * label re-dispatches its click to the labelable control even when that control
 * was the original target, so a direct click on the box fired onChange twice
 * (real click + label-forwarded click) and cancelled itself out. Clicking the
 * text only fired once, which is why the text worked but the box didn't.
 *
 * The fix stops the box's click from bubbling to any surrounding clickable row,
 * so a single click is always a single toggle. These tests guard that a click
 * on the box (a) toggles exactly once and (b) does not also trigger a parent
 * onClick handler.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Checkbox } from './checkbox';

describe('Checkbox', () => {
  it('fires onChange exactly once per click', () => {
    const onChange = vi.fn();
    render(<Checkbox checked={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('does not propagate the click to a surrounding clickable row', () => {
    const rowClick = vi.fn();
    const onChange = vi.fn();
    render(
      <div onClick={rowClick}>
        <Checkbox checked={false} onChange={onChange} />
      </div>,
    );
    fireEvent.click(screen.getByRole('checkbox'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(rowClick).not.toHaveBeenCalled();
  });

  it('reflects the checked state via aria-checked', () => {
    const { rerender } = render(<Checkbox checked={false} onChange={() => {}} />);
    expect(screen.getByRole('checkbox')).toHaveAttribute('aria-checked', 'false');
    rerender(<Checkbox checked onChange={() => {}} />);
    expect(screen.getByRole('checkbox')).toHaveAttribute('aria-checked', 'true');
  });
});
