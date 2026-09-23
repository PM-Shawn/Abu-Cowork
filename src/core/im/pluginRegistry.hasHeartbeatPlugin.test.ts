/**
 * The predicate the trigger server and the IM settings row share.
 *
 * Both ask it about the same thing — whether anything installed actually needs
 * the LAN callback listener — so it is pinned on its own: a second copy that
 * drifted would either bind 0.0.0.0 for a plugin that does not need it, or
 * tell the user to open the listener for one that is not there.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { IMAdapter } from './adapters/base';
import {
  hasHeartbeatPlugin,
  registerIMPlugin,
  unregisterIMPlugin,
  type IMPluginManifest,
} from './pluginRegistry';

type ConnectionType = IMPluginManifest['capabilities']['connectionType'];

const registered: string[] = [];

function register(platform: string, connectionType: ConnectionType): void {
  registerIMPlugin({
    manifest: {
      platform,
      displayName: platform,
      shortLabel: platform.slice(0, 2).toUpperCase(),
      capabilities: { markdown: false, card: false, messageUpdate: false, connectionType },
    },
    adapter: {} as IMAdapter,
    parseInbound: () => null,
  });
  registered.push(platform);
}

afterEach(() => {
  while (registered.length > 0) unregisterIMPlugin(registered.pop() as string);
});

describe('hasHeartbeatPlugin', () => {
  it('is false with nothing registered', () => {
    expect(hasHeartbeatPlugin()).toBe(false);
  });

  it('is false for plugins that receive messages another way', () => {
    register('hook-only', 'webhook');
    register('socket-only', 'websocket');
    expect(hasHeartbeatPlugin()).toBe(false);
  });

  it('is true as soon as one registered plugin keeps a heartbeat', () => {
    register('hook-only', 'webhook');
    register('beats', 'heartbeat');
    expect(hasHeartbeatPlugin()).toBe(true);
  });

  it('goes back to false when that plugin is unregistered', () => {
    register('beats', 'heartbeat');
    unregisterIMPlugin(registered.pop() as string);
    expect(hasHeartbeatPlugin()).toBe(false);
  });
});
