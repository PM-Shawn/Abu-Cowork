import { expect, it } from 'vitest';
import { acquirePluginUse, acquirePluginChange } from './runtimeLease';

it('refuses changes during active use and does not double-release nested use', () => {
  const first = acquirePluginUse('demo'); const second = acquirePluginUse('demo');
  expect(() => acquirePluginChange('demo')).toThrow('in use');
  first(); first();
  expect(() => acquirePluginChange('demo')).toThrow('in use');
  second();
  const release = acquirePluginChange('demo');
  expect(() => acquirePluginUse('demo')).toThrow('being updated');
  expect(() => acquirePluginChange('demo')).toThrow('in use');
  release();
  acquirePluginUse('demo')();
});
it('independent capabilities do not acquire a plugin lease', () => {
  acquirePluginUse(undefined)(); acquirePluginUse(null)();
});
