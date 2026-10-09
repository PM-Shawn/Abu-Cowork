// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Button } from '@/components/ds/button';
import { TextArea } from '@/components/ds/text-area';
import { SidebarColumn } from './SidebarColumn';

function Layout({ collapsed }: { collapsed: boolean }) {
  return (
    <>
      <Button>显示侧栏</Button>
      <SidebarColumn collapsed={collapsed}>
        <Button>新任务</Button>
        <Button>专家</Button>
      </SidebarColumn>
      <TextArea aria-label="composer" />
    </>
  );
}

describe('SidebarColumn', () => {
  // happy-dom's tab order ignores `inert`; the real Electron walkthrough checks the key path.
  it('keeps a collapsed sidebar out of the tab order', () => {
    render(<Layout collapsed />);
    const column = document.querySelector('[data-abu-sidebar-column]');
    expect(column).toHaveAttribute('inert');
    expect(screen.getByRole('button', { name: '新任务', hidden: true }).closest('[inert]')).toBe(column);
  });

  it('puts the sidebar back in the tab order when expanded', async () => {
    const user = userEvent.setup();
    render(<Layout collapsed={false} />);
    const column = document.querySelector('[data-abu-sidebar-column]');
    expect(column).not.toHaveAttribute('inert');
    screen.getByRole('button', { name: '显示侧栏' }).focus();
    await user.tab();
    expect(screen.getByRole('button', { name: '新任务' })).toHaveFocus();
  });

  it('is zero wide when collapsed and 260px when expanded', () => {
    const { rerender } = render(<SidebarColumn collapsed>x</SidebarColumn>);
    const column = document.querySelector<HTMLElement>('[data-abu-sidebar-column]')!;
    expect(column.style.width).toBe('0px');
    rerender(<SidebarColumn collapsed={false}>x</SidebarColumn>);
    expect(column.style.width).toBe('260px');
  });
});
