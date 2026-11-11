import { afterEach, describe, expect, it } from 'vitest';
import { useSettingsStore } from '../../stores/settingsStore';
import { effectivePermissionMode } from './effectivePermissionMode';

describe('effectivePermissionMode', () => {
  const original = useSettingsStore.getState().permissionMode;
  afterEach(() => useSettingsStore.setState({ permissionMode: original }));

  it('falls back to the global mode when no layer is set', () => {
    useSettingsStore.setState({ permissionMode: 'smart' });
    expect(effectivePermissionMode()).toBe('smart');
    expect(effectivePermissionMode(undefined, null)).toBe('smart');
  });

  it('takes the first layer that is set, before the global mode', () => {
    useSettingsStore.setState({ permissionMode: 'smart' });
    expect(effectivePermissionMode('autonomous', 'standard')).toBe('autonomous');
    expect(effectivePermissionMode(undefined, 'standard')).toBe('standard');
  });
});
