// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import CapabilityScopeToggle from './CapabilityScopeToggle';

describe('CapabilityScopeToggle', () => {
  it('exposes the active source and selects the organization catalog', () => {
    const onChange = vi.fn();
    render(
      <CapabilityScopeToggle
        value="personal"
        onChange={onChange}
        personalLabel="Mine"
        organizationLabel="Organization"
      />,
    );

    expect(screen.getByRole('button', { name: 'Mine' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Organization' })).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(screen.getByRole('button', { name: 'Organization' }));
    expect(onChange).toHaveBeenCalledWith('organization');
  });
});
