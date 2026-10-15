// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import MathFormula from './MathFormula';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('MathFormula', () => {
  it('renders inline TeX inside a span', () => {
    const { container } = render(<MathFormula tex="x^2" display={false} />);
    expect(container.firstElementChild?.tagName).toBe('SPAN');
    expect(container.querySelector('.katex')).not.toBeNull();
    expect(container.querySelector('.katex-display')).toBeNull();
  });

  it('renders display TeX as a block that scrolls sideways when it is wide', () => {
    const { container } = render(<MathFormula tex="\int_0^1 x\,dx" display />);
    expect(container.firstElementChild?.tagName).toBe('DIV');
    expect(container.firstElementChild?.className).toContain('overflow-x-auto');
    expect(container.querySelector('.katex-display')).not.toBeNull();
  });

  it('shows TeX that does not parse as its source in the secondary label color', () => {
    const { container } = render(<MathFormula tex="\frac{a" display={false} />);
    const error = container.querySelector<HTMLElement>('.katex-error');
    expect(error).not.toBeNull();
    expect(error?.textContent).toBe('\\frac{a');
    expect(error?.getAttribute('style')).toContain('var(--ds-label-secondary)');
  });

  it('accepts Chinese text in a formula without a console warning', () => {
    const warn = vi.spyOn(console, 'warn');
    render(<MathFormula tex="\text{面积} = a \times b" display={false} />);
    expect(warn).not.toHaveBeenCalled();
  });

  it('turns no link command into a link', () => {
    const { container } = render(<MathFormula tex="\href{javascript:alert(1)}{x}" display={false} />);
    expect(container.querySelector('a')).toBeNull();
  });
});
