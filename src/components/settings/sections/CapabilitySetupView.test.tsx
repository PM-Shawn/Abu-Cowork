// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Button } from '@/components/ds/button';
import { AppIcons } from '@/components/ds/icons';
import type { ComputerUsePermissions } from '@/core/agent/computerUsePermission';
import { initLanguage } from '@/i18n';
import { CapabilityStatusRow, ComputerUseSetupView, StatusBadge } from './CapabilitySetupView';

const spinners = () => Array.from(document.querySelectorAll('[data-ds-spinner]'));

function props() {
  return {
    enabled: true, requestedByTask: false,
    permissions: { screenRead: false, uiControl: false, screenReadStatus: 'denied', uiControlStatus: 'denied', restartRequired: false } satisfies ComputerUsePermissions,
    checking: false, revealingApp: false, canOpenSystemSettings: true,
    onBack: vi.fn(), onEnable: vi.fn(), onDisable: vi.fn(), onRequestPermission: vi.fn(),
    onRevealApp: vi.fn(), onRefresh: vi.fn(), onDone: vi.fn(),
  };
}
beforeEach(() => initLanguage('en-US'));
afterEach(cleanup);
describe('ComputerUseSetupView', () => {
  it('allows either permission to be requested first and shows granted state', () => {
    const p = props();
    const { rerender } = render(<ComputerUseSetupView {...p} />);
    expect(screen.getAllByText('View screen')).toHaveLength(1);
    expect(screen.getAllByText('Control interface')).toHaveLength(1);
    fireEvent.click(screen.getAllByRole('button', { name: 'Grant access' })[1]);
    expect(p.onRequestPermission).toHaveBeenLastCalledWith('uiControl');
    fireEvent.click(screen.getAllByRole('button', { name: 'Grant access' })[0]);
    expect(p.onRequestPermission).toHaveBeenLastCalledWith('screenRead');
    rerender(<ComputerUseSetupView {...p} permissions={{ ...p.permissions, screenRead: true, uiControl: false }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Grant access' }));
    expect(p.onRequestPermission).toHaveBeenLastCalledWith('uiControl');
  });
  it('honors a task requiring only interface control', () => {
    const p = props();
    render(<ComputerUseSetupView {...p} requirements={{ screenRead: false, uiControl: true }} />);
    expect(screen.queryByText('View screen')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Grant access' }));
    expect(p.onRequestPermission).toHaveBeenCalledWith('uiControl');
  });
  it('keeps explicit enable and disable actions on the labelled switch', () => {
    const p = props();
    const { rerender } = render(<ComputerUseSetupView {...p} />);
    fireEvent.click(screen.getByRole('switch', { name: 'Turn off Computer Use' }));
    expect(p.onDisable).toHaveBeenCalledOnce();
    rerender(<ComputerUseSetupView {...p} enabled={false} />);
    expect(screen.queryByRole('button', { name: 'Grant access' })).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: 'Enable Computer Use' }));
    expect(p.onEnable).toHaveBeenCalledOnce();
  });
  it('does not offer permission actions during a restart-required state', () => {
    const p = props();
    render(<ComputerUseSetupView {...p} permissions={{ ...p.permissions, screenRead: true, uiControl: true, restartRequired: true }} />);
    expect(screen.queryByRole('button', { name: 'Grant access' })).toBeNull();
    expect(screen.queryByText('Permissions ready')).toBeNull();
    expect(screen.getByText('System permissions have changed. Reopen Abu for them to take effect.')).toBeTruthy();
  });
  it('allows task continuation only when its required permissions are ready', () => {
    const p = props();
    const { rerender } = render(<ComputerUseSetupView {...p} requestedByTask />);
    expect(screen.queryByRole('button', { name: 'Return to task' })).toBeNull();
    rerender(<ComputerUseSetupView {...p} requestedByTask permissions={{ ...p.permissions, screenRead: true, uiControl: true }} />);
    expect(screen.queryByRole('button', { name: 'Grant access' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Return to task' }));
    expect(p.onDone).toHaveBeenCalledOnce();
  });
  it('shows both granted permissions after setup', () => {
    const p = props();
    render(<ComputerUseSetupView {...p} permissions={{ ...p.permissions, screenRead: true, uiControl: true }} />);
    expect(screen.getByText('Ready to use')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'System permissions' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Grant access' })).toBeNull();
    expect(screen.getAllByText('Granted')).toHaveLength(2);
    expect(screen.getByText('View permission setup help')).toBeTruthy();
  });
  it('does not claim usability when the model is incompatible', () => {
    const p = props();
    render(<ComputerUseSetupView {...p} modelIssue="This model cannot call tools."
      permissions={{ ...p.permissions, screenRead: true, uiControl: true }} />);
    expect(screen.queryByText('Ready to use')).toBeNull();
    expect(screen.getByText('This model cannot call tools.')).toBeTruthy();
  });

  // The window a task opens puts focus on its first control. That control is Cancel.
  it('starts a page a task opened with Cancel, which goes back and does nothing else', () => {
    const p = props();
    render(<ComputerUseSetupView {...p} requestedByTask breadcrumb={['Capabilities', 'Computer Use']}
      permissions={{ ...p.permissions, screenRead: true, uiControl: true }} />);
    const first = screen.getAllByRole('button')[0];
    expect(first.textContent).toBe('Cancel');
    expect(screen.queryByRole('button', { name: 'Back to Capabilities' })).toBeNull();
    fireEvent.click(first);
    expect(p.onBack).toHaveBeenCalledOnce();
    expect(p.onDone).not.toHaveBeenCalled();
    expect(p.onEnable).not.toHaveBeenCalled();
    expect(p.onDisable).not.toHaveBeenCalled();
  });
  it('starts a page the user opened with the trail back to the overview', () => {
    const p = props();
    render(<ComputerUseSetupView {...p} breadcrumb={['Capabilities', 'Computer Use']} />);
    const first = screen.getAllByRole('button')[0];
    expect(first.getAttribute('aria-label')).toBe('Back to Capabilities');
    expect(first.textContent).toBe('Capabilities');
    fireEvent.click(first);
    expect(p.onBack).toHaveBeenCalledWith(0);
  });
  it('checks again on request, and holds every permission action while a check or a request runs', () => {
    const p = props();
    const { rerender } = render(<ComputerUseSetupView {...p} />);
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(p.onRefresh).toHaveBeenCalledOnce();

    rerender(<ComputerUseSetupView {...p} checking />);
    expect(screen.getByText('Checking')).toBeTruthy();
    expect(screen.queryByText('Setup required')).toBeNull();
    expect(screen.getByRole('button', { name: 'Check again' }).hasAttribute('disabled')).toBe(true);
    for (const grant of screen.getAllByRole('button', { name: 'Grant access' })) {
      expect(grant.hasAttribute('disabled')).toBe(true);
    }

    rerender(<ComputerUseSetupView {...p} requesting="uiControl" />);
    expect(screen.getByRole('button', { name: 'Check again' }).hasAttribute('disabled')).toBe(true);
    for (const grant of screen.getAllByRole('button', { name: 'Grant access' })) {
      expect(grant.hasAttribute('disabled')).toBe(true);
    }
  });
  it('offers the restart only when one is required', () => {
    const p = { ...props(), onRelaunch: vi.fn() };
    const { rerender } = render(<ComputerUseSetupView {...p} />);
    expect(screen.queryByRole('button', { name: 'Restart Abu' })).toBeNull();
    rerender(<ComputerUseSetupView {...p} permissions={{ ...p.permissions, restartRequired: true }} />);
    expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Restart Abu' }));
    expect(p.onRelaunch).toHaveBeenCalledOnce();
  });
  it('reveals the app from the permission help, and holds that button while it works', () => {
    const p = props();
    const { rerender } = render(<ComputerUseSetupView {...p} />);
    fireEvent.click(screen.getByText('View permission setup help'));
    fireEvent.click(screen.getByRole('button', { name: 'Show Abu in Finder' }));
    expect(p.onRevealApp).toHaveBeenCalledOnce();
    rerender(<ComputerUseSetupView {...p} revealingApp />);
    expect(screen.getByRole('button', { name: 'Show Abu in Finder' }).hasAttribute('disabled')).toBe(true);
  });
  it('says the permission cannot be granted here on a system without the settings pane', () => {
    const p = props();
    render(<ComputerUseSetupView {...p} canOpenSystemSettings={false} />);
    expect(screen.queryByRole('button', { name: 'Grant access' })).toBeNull();
    expect(screen.getAllByText('Not allowed')).toHaveLength(2);
  });

  // One spinner per place: the status title. Buttons keep still icons.
  it('shows one spinner while checking, in place of the status title', () => {
    const p = props();
    const { rerender } = render(<ComputerUseSetupView {...p} />);
    expect(spinners()).toHaveLength(0);
    rerender(<ComputerUseSetupView {...p} checking />);
    expect(spinners()).toHaveLength(1);
    expect(screen.getByRole('status').textContent).toBe('Checking');
    // The status title it stands in for is text-ui.
    expect(screen.getByText('Checking')).toHaveClass('text-ui');
    expect(screen.getByRole('button', { name: 'Check again' }).querySelector('[data-ds-spinner]')).toBeNull();
  });
  it('shows no spinner while waiting for the user: a system permission prompt or Finder', () => {
    const p = props();
    const { rerender } = render(<ComputerUseSetupView {...p} requesting="screenRead" />);
    expect(spinners()).toHaveLength(0);
    // The row that is waiting marks its button with a still icon; the other row has none.
    const [screenGrant, controlGrant] = screen.getAllByRole('button', { name: 'Grant access' });
    expect(screenGrant.querySelector('svg')).not.toBeNull();
    expect(controlGrant.querySelector('svg')).toBeNull();
    rerender(<ComputerUseSetupView {...p} revealingApp />);
    fireEvent.click(screen.getByText('View permission setup help'));
    expect(spinners()).toHaveLength(0);
  });
  it('keeps each permission title, its action and its state under one parent', () => {
    const p = props();
    render(<ComputerUseSetupView {...p} permissions={{ ...p.permissions, screenRead: true }} />);
    const screenRow = screen.getByRole('heading', { level: 4, name: 'View screen' }).parentElement!;
    const controlRow = screen.getByRole('heading', { level: 4, name: 'Control interface' }).parentElement!;
    expect(within(screenRow).getByText('Granted')).toBeTruthy();
    expect(within(controlRow).getByRole('button', { name: 'Grant access' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3, name: 'Computer Use' })).toBeTruthy();
  });
});

describe('StatusBadge', () => {
  it('spins only where the page asks for it, and always says what is being checked', () => {
    const { rerender } = render(<StatusBadge label="Checking" tone="neutral" checking spinning />);
    expect(spinners()).toHaveLength(1);
    expect(screen.getByRole('status').textContent).toBe('Checking');
    // Several cards can be checking at once, so a card shows a still icon.
    rerender(<StatusBadge label="Checking" tone="neutral" checking />);
    expect(spinners()).toHaveLength(0);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByText('Checking').querySelector('svg')).not.toBeNull();
    // Not checking: `spinning` alone shows nothing moving.
    rerender(<StatusBadge label="Ready" tone="ready" spinning />);
    expect(spinners()).toHaveLength(0);
    expect(screen.getByText('Ready')).toBeTruthy();
  });
  it('gives each outcome its own shape, and none to the neutral one', () => {
    const { rerender } = render(<StatusBadge label="Ready" tone="ready" />);
    expect(screen.getByText('Ready').className).toContain('text-success');
    expect(screen.getByText('Ready').querySelector('svg')).not.toBeNull();
    rerender(<StatusBadge label="Setup required" tone="attention" />);
    expect(screen.getByText('Setup required').className).toContain('text-warning');
    expect(screen.getByText('Setup required').querySelector('svg')).not.toBeNull();
    rerender(<StatusBadge label="Off" tone="neutral" />);
    expect(screen.getByText('Off').querySelector('svg')).toBeNull();
  });
});

describe('CapabilityStatusRow', () => {
  it('shows its one spinner while checking and leaves the action icon still', () => {
    render(<CapabilityStatusRow label="Checking" tone="attention" checking note="The runtime is disconnected."
      action={<Button icon={AppIcons.retry}>Retry</Button>} />);
    expect(spinners()).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Retry' }).querySelector('[data-ds-spinner]')).toBeNull();
    expect(screen.getByText('The runtime is disconnected.')).toBeTruthy();
  });

});
