// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button } from '@/components/ds/button';
import { DesignSystemProvider } from '@/components/ds/provider';
import SettingsSectionHeader from './SettingsSectionHeader';
import { SettingsHeaderContext } from './settingsHeaderContext';

afterEach(cleanup);

describe('SettingsSectionHeader', () => {
  it('keeps the title and action in the fixed header while the description stays with the form', async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    const host = document.createElement('div');
    document.body.append(host);
    const view = render(
      <DesignSystemProvider>
        <SettingsHeaderContext.Provider value={host}>
          <SettingsSectionHeader title="Models" description="Configured services" action={<Button onClick={onAdd}>Add</Button>} />
        </SettingsHeaderContext.Provider>
      </DesignSystemProvider>,
    );
    expect(within(host).getByRole('heading', { name: 'Models' })).toBeVisible();
    expect(within(view.container).queryByRole('heading')).toBeNull();
    expect(within(view.container).getByText('Configured services')).toBeVisible();
    const add = within(host).getByRole('button', { name: 'Add' });
    add.focus();
    await user.keyboard('{Enter}');
    expect(onAdd).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(host).toBeEmptyDOMElement();
    host.remove();
  });

  it('shows a standalone title and its accessory when no settings window owns the section', () => {
    render(<SettingsSectionHeader title="Memory" description="Saved facts" titleAccessory={<span>Guide</span>} />);
    expect(screen.getByRole('heading', { name: 'Memory' })).toBeVisible();
    expect(screen.getByText('Guide')).toBeVisible();
    expect(screen.getByText('Saved facts')).toBeVisible();
  });

  it('waits for the fixed header to mount without adding a title to the scrolling form', () => {
    render(
      <SettingsHeaderContext.Provider value={null}>
        <SettingsSectionHeader title="Models" description="Configured services" />
      </SettingsHeaderContext.Provider>,
    );
    expect(screen.queryByRole('heading')).toBeNull();
    expect(screen.getByText('Configured services')).toBeVisible();
  });
});
