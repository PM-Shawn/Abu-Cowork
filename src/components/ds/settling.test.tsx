// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { StrictMode, createRef } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Button } from './button';
import { Settling } from './settling';
import { TOAST_SETTLE_MS } from './styles';

// A part of the page that is no layer and paints its answering controls by itself.
describe('Settling', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const by = (name: string) => screen.getByRole('button', { name });
  // A pointer press as the browser reports it; a click raised by a key says detail 0.
  const pointerPress = (name: string, detail = 1) => {
    fireEvent.pointerDown(by(name));
    if (fireEvent.mouseDown(by(name))) by(name).focus();
    fireEvent.click(by(name), { detail });
  };
  const settle = () => act(() => { vi.advanceTimersByTime(TOAST_SETTLE_MS); });
  const box = () => screen.getByTestId('box');

  it('takes no pointer press when it has just joined the page, leaves the focus where it was, and takes one made after the interval', () => {
    const onAnswer = vi.fn();
    render(<><Button>Elsewhere</Button><Settling data-testid="box"><Button onClick={onAnswer}>Answer</Button></Settling></>);
    by('Elsewhere').focus();
    expect(box()).toHaveAttribute('data-ds-settling', '');
    pointerPress('Answer');
    expect(onAnswer).not.toHaveBeenCalled();
    expect(by('Elsewhere')).toHaveFocus();

    act(() => { vi.advanceTimersByTime(TOAST_SETTLE_MS - 1); });
    pointerPress('Answer');
    expect(onAnswer).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(box()).not.toHaveAttribute('data-ds-settling');
    pointerPress('Answer');
    expect(onAnswer).toHaveBeenCalledTimes(1);
  });

  it('does not take a press that began inside the interval, however late it ends', () => {
    const onAnswer = vi.fn();
    render(<Settling><Button onClick={onAnswer}>Answer</Button></Settling>);
    act(() => { vi.advanceTimersByTime(TOAST_SETTLE_MS - 20); });
    fireEvent.pointerDown(by('Answer'));
    act(() => { vi.advanceTimersByTime(70); });
    fireEvent.click(by('Answer'), { detail: 1 });
    expect(onAnswer).not.toHaveBeenCalled();
    pointerPress('Answer');
    expect(onAnswer).toHaveBeenCalledTimes(1);
  });

  it('never holds the keyboard', () => {
    const onAnswer = vi.fn();
    render(<Settling><Button onClick={onAnswer}>Answer</Button></Settling>);
    fireEvent.click(by('Answer'), { detail: 0 });
    expect(onAnswer).toHaveBeenCalledTimes(1);
  });

  it('counts again when its settleKey changes, and only then', () => {
    const onAnswer = vi.fn();
    const page = (key: number) => <Settling data-testid="box" settleKey={key}><Button onClick={onAnswer}>Answer</Button></Settling>;
    const view = render(page(0));
    settle();
    view.rerender(page(0));
    expect(box()).not.toHaveAttribute('data-ds-settling');
    view.rerender(page(1));
    expect(box()).toHaveAttribute('data-ds-settling', '');
    pointerPress('Answer', 2);
    expect(onAnswer).not.toHaveBeenCalled();
    settle();
    pointerPress('Answer');
    expect(onAnswer).toHaveBeenCalledTimes(1);
  });

  it('holds a part inside it by that part\'s own count: the rest of the box stays in use', () => {
    const onPage = vi.fn();
    const onAnswer = vi.fn();
    const dock = (key: number) => (
      <Settling data-testid="box">
        <Button onClick={onPage}>Next page</Button>
        <Settling data-testid="answers" settleKey={key}><Button onClick={onAnswer}>Answer</Button></Settling>
      </Settling>
    );
    const view = render(dock(0));
    settle();
    view.rerender(dock(1));
    expect(box()).not.toHaveAttribute('data-ds-settling');
    expect(screen.getByTestId('answers')).toHaveAttribute('data-ds-settling', '');
    pointerPress('Next page');
    pointerPress('Answer');
    expect(onPage).toHaveBeenCalledTimes(1);
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it('gives its box to the caller\'s ref and passes its attributes on', () => {
    const ref = createRef<HTMLDivElement>();
    render(<Settling ref={ref} data-testid="box" role="group" tabIndex={-1} className="rounded-panel" />);
    expect(ref.current).toBe(box());
    expect(box()).toHaveAttribute('role', 'group');
    expect(box()).toHaveAttribute('tabindex', '-1');
    expect(box()).toHaveClass('rounded-panel');
  });

  it('becomes pressable after the interval when React runs its effects twice (StrictMode)', () => {
    const onAnswer = vi.fn();
    render(<StrictMode><Settling data-testid="box"><Button onClick={onAnswer}>Answer</Button></Settling></StrictMode>);
    expect(box()).toHaveAttribute('data-ds-settling', '');
    settle();
    expect(box()).not.toHaveAttribute('data-ds-settling');
    pointerPress('Answer');
    expect(onAnswer).toHaveBeenCalledTimes(1);
  });

  it('leaves no timer behind when it leaves the page inside the interval', () => {
    const view = render(<Settling><Button>Answer</Button></Settling>);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
