// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import DefaultUserAvatar from './DefaultUserAvatar';

afterEach(cleanup);

describe('DefaultUserAvatar', () => {
  it('paints the account glyph in the identity colours and fills its frame', () => {
    const { container } = render(<DefaultUserAvatar />);
    const box = container.firstElementChild as HTMLElement;
    expect(box).toHaveClass('bg-brand');
    expect(box).toHaveClass('text-brand-ink');
    expect(box).toHaveClass('size-full');
    expect(box.className).not.toContain('abu-clay');
    const glyph = box.querySelector('svg');
    expect(glyph).not.toBeNull();
    // A design-system icon: decorative, fixed stroke, half the frame.
    expect(glyph).toHaveAttribute('aria-hidden', 'true');
    expect(glyph).toHaveAttribute('stroke-width', '1.5');
    expect(glyph).toHaveClass('size-1/2');
    expect(glyph?.getAttribute('class')).not.toContain('abu-clay');
  });

  it('keeps a class the caller adds', () => {
    const { container } = render(<DefaultUserAvatar className="rounded-full" />);
    expect(container.firstElementChild).toHaveClass('rounded-full');
  });
});
