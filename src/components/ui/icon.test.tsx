// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Icon } from './icon';
import { AppIcons } from './icons';

describe('Icon', () => {
  it('renders 16px with a 1.5 stroke by default', () => {
    const { container } = render(<Icon icon={AppIcons.copy} />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('width', '16');
    expect(svg).toHaveAttribute('height', '16');
    expect(svg).toHaveAttribute('stroke-width', '1.5');
  });

  it.each([
    ['sm', '14'],
    ['md', '16'],
    ['lg', '20'],
  ] as const)('renders size %s as %spx', (size, px) => {
    const { container } = render(<Icon icon={AppIcons.add} size={size} />);
    expect(container.querySelector('svg')).toHaveAttribute('width', px);
  });

  it('is hidden from assistive tech when it has no label', () => {
    const { container } = render(<Icon icon={AppIcons.close} />);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('is announced as an image when it has a label', () => {
    const { getByRole } = render(<Icon icon={AppIcons.warning} label="Warning" />);
    expect(getByRole('img', { name: 'Warning' })).toBeInTheDocument();
  });
});

describe('AppIcons', () => {
  it('maps every standard action to a renderable icon', () => {
    for (const [name, glyph] of Object.entries(AppIcons)) {
      const { container, unmount } = render(<Icon icon={glyph} />);
      expect(container.querySelector('svg'), name).not.toBeNull();
      unmount();
    }
  });
});
