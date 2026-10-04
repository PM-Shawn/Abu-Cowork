// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import AppLogo from './AppLogo';

describe('AppLogo', () => {
  afterEach(() => cleanup());

  it('shows the first letter of the name, hidden from screen readers, when the package ships no image', () => {
    render(<AppLogo name="  Shop desk" />);
    const logo = screen.getByTestId('app-logo');
    expect(logo).toHaveAttribute('data-app-logo', 'letter');
    expect(logo).toHaveAttribute('aria-hidden', 'true');
    expect(logo).toHaveTextContent('S');
  });

  it('draws the letter mark with design-system classes', () => {
    render(<AppLogo name="Shop desk" />);
    const logo = screen.getByTestId('app-logo');
    expect(logo).toHaveClass('rounded-control');
    expect(logo).toHaveClass('bg-fill');
    expect(logo).toHaveClass('text-label');
    expect(logo).toHaveClass('font-medium');
  });

  it.each([
    ['sm', 'h-5', 'text-caption'],
    ['md', 'h-7', 'text-ui-sm'],
    ['lg', 'h-10', 'text-title'],
    ['xl', 'h-20', 'text-title-lg'],
  ] as const)('size %s is %s with %s letters', (size, box, text) => {
    render(<AppLogo name="Shop desk" size={size} />);
    expect(screen.getByTestId('app-logo')).toHaveClass(box);
    expect(screen.getByTestId('app-logo')).toHaveClass(text);
  });

  it('lets the caller change the corner and the size', () => {
    render(<AppLogo name="Shop desk" size="sm" className="h-4 w-4 rounded-window" />);
    const logo = screen.getByTestId('app-logo');
    expect(logo).toHaveClass('rounded-window');
    expect(logo).not.toHaveClass('rounded-control');
    expect(logo).toHaveClass('h-4');
    expect(logo).not.toHaveClass('h-5');
  });

  it('shows the avatar of Abu for the general shell', () => {
    render(<AppLogo name="Abu" general />);
    const logo = screen.getByTestId('app-logo');
    expect(logo).toHaveAttribute('data-app-logo', 'general');
    expect(logo.querySelector('img')).not.toBeNull();
  });
});
