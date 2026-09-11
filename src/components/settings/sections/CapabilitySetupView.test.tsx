// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComputerUsePermissions } from '@/core/agent/computerUsePermission';
import { initLanguage } from '@/i18n';
import { ComputerUseSetupView } from './CapabilitySetupView';

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

});
