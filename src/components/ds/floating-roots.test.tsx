// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Button } from './button';
import { Dialog } from './dialog';
import { Menu, MenuItem } from './menu';
import { Popover } from './popover';
import { DesignSystemProvider } from './provider';

const MARKER = 'data-electron-no-drag';

// Floating layers are portaled out of <main>, so each root must opt out of the window drag lanes itself.
describe('floating layers opt out of the window drag lanes', () => {
  it('marks the menu content', () => {
    render(
      <Menu defaultOpen trigger={<Button>Actions</Button>}>
        <MenuItem>Rename</MenuItem>
      </Menu>,
      { wrapper: DesignSystemProvider },
    );
    expect(screen.getByRole('menu')).toHaveAttribute(MARKER);
  });

  it('marks the popover content', () => {
    render(<Popover defaultOpen trigger={<Button>Details</Button>}>Popover body</Popover>, { wrapper: DesignSystemProvider });
    expect(screen.getByText('Popover body').closest('[data-ds-layer]')).toHaveAttribute(MARKER);
  });

  it('marks the dialog content and its scrim', () => {
    render(<Dialog defaultOpen title="Rename task">Body</Dialog>, { wrapper: DesignSystemProvider });
    expect(screen.getByRole('dialog')).toHaveAttribute(MARKER);
    const scrim = document.querySelector('.bg-scrim');
    expect(scrim).not.toBeNull();
    expect(scrim).toHaveAttribute(MARKER);
  });
});
