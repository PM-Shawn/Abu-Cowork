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

  it('opens its tooltip above by default and on the side it is given', async () => {
    const user = userEvent.setup();
    render(
      <>
        <IconButton icon={AppIcons.copy} label="Copy code" />
        <IconButton icon={AppIcons.reload} label="Reload" tooltipSide="bottom" />
      </>,
      { wrapper: DesignSystemProvider },
    );
    await user.tab();
    expect((await screen.findByRole('tooltip')).closest('[data-side]')).toHaveAttribute('data-side', 'top');
    await user.tab();
    expect(screen.getByRole('button', { name: 'Reload' })).toHaveFocus();
    await screen.findByText('Reload', { selector: '[role="tooltip"]' });
    expect(screen.getByRole('tooltip').closest('[data-side]')).toHaveAttribute('data-side', 'bottom');
    expect(screen.getByRole('button', { name: 'Reload' })).not.toHaveAttribute('tooltipside');
  });

  it('fails fast outside DesignSystemProvider', () => {
    expect(() => render(<IconButton icon={AppIcons.copy} label="Copy" />)).toThrow(/DesignSystemProvider/);
  });

  it('renders the primary icon button filled with the emphasis color', () => {
    render(<IconButton icon={AppIcons.add} label="Send" variant="primary" />, { wrapper: DesignSystemProvider });
    const button = screen.getByRole('button', { name: 'Send' });
    expect(button).toHaveClass('bg-emphasis', 'text-on-emphasis');
    // One class per assertion: not.toHaveClass with several names passes when any one is missing.
    expect(button).not.toHaveClass('text-label-secondary');
    expect(button).not.toHaveClass('hover:text-label');
  });

  // A pressed toggle keeps its selected fill while the pointer rests on it; callers only set aria-pressed.
  it('gives a pressed toggle its own fill, text color, hover and press-down classes', () => {
    render(<IconButton icon={AppIcons.preview} label="Preview" aria-pressed />, { wrapper: DesignSystemProvider });
    const button = screen.getByRole('button', { name: 'Preview' });
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(button).toHaveClass('aria-pressed:bg-fill-selected');
    expect(button).toHaveClass('aria-pressed:text-label');
    expect(button).toHaveClass('aria-pressed:hover:bg-fill-selected');
    expect(button).toHaveClass('aria-pressed:active:bg-fill-pressed');
  });

  // A mark that shows its state in the icon itself (a filled star) is still a toggle, without the fill.
  it('lets a pressed toggle opt out of the pressed fill and keeps aria-pressed', () => {
    render(<IconButton icon={AppIcons.favorite} label="Favorite" aria-pressed pressedFill={false} />, { wrapper: DesignSystemProvider });
    const button = screen.getByRole('button', { name: 'Favorite' });
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(button).not.toHaveAttribute('pressedfill');
    expect(button).not.toHaveClass('aria-pressed:bg-fill-selected');
    expect(button).not.toHaveClass('aria-pressed:text-label');
    expect(button).not.toHaveClass('aria-pressed:hover:bg-fill-selected');
    expect(button).not.toHaveClass('aria-pressed:active:bg-fill-pressed');
    // It stays an ordinary plain button under the pointer.
    expect(button).toHaveClass('hover:bg-fill-hover');
    expect(button).toHaveClass('text-label-secondary');
  });
});
