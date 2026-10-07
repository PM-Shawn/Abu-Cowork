// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Button, IconButton } from './button';
import { AppIcons } from './icons';
import { DesignSystemProvider } from './provider';

describe('Button', () => {
  it('is a plain button by default and runs its handler', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button).toHaveAttribute('type', 'button');
    await user.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it.each([
    ['primary', 'bg-emphasis'],
    ['secondary', 'bg-fill'],
    ['plain', 'hover:bg-fill-hover'],
    ['danger', 'text-danger'],
  ] as const)('styles the %s variant', (variant, token) => {
    render(<Button variant={variant}>Go</Button>);
    expect(screen.getByRole('button', { name: 'Go' })).toHaveClass(token);
  });

  it('uses the two control heights', () => {
    render(<><Button size="sm">Small</Button><Button>Regular</Button></>);
    expect(screen.getByRole('button', { name: 'Small' })).toHaveClass('h-6');
    expect(screen.getByRole('button', { name: 'Regular' })).toHaveClass('h-7');
  });

  it('cannot be clicked while disabled', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button disabled onClick={onClick}>Send</Button>);
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('IconButton', () => {
  it('is named by its label and shows the same label as a tooltip on focus', async () => {
    const user = userEvent.setup();
    render(<IconButton icon={AppIcons.copy} label="Copy code" />, { wrapper: DesignSystemProvider });
    const button = screen.getByRole('button', { name: 'Copy code' });
    expect(button.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    await user.tab();
    expect(button).toHaveFocus();
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Copy code');
  });

  it('fails fast outside DesignSystemProvider', () => {
    expect(() => render(<IconButton icon={AppIcons.copy} label="Copy" />)).toThrow(/DesignSystemProvider/);
  });
});
