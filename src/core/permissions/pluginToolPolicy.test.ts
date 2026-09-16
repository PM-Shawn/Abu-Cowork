import { describe, it, expect, beforeEach } from 'vitest';
import {
  classifyPluginTool,
  setPluginServerNames,
  getPluginServerNames,
  hasPluginGrant,
  grantPluginServer,
  forgetPluginGrants,
  PLUGIN_GRANT_TTL_MS,
} from './pluginToolPolicy';

describe('pluginToolPolicy', () => {
  beforeEach(() => {
    setPluginServerNames([]);
    forgetPluginGrants();
  });

  describe('classifyPluginTool', () => {
    it('returns null when the server is not plugin-contributed', () => {
      setPluginServerNames(['weather']);
      expect(classifyPluginTool('something-else__do_thing')).toBeNull();
    });

    it('classifies a plugin-contributed MCP tool as state-changing', () => {
      setPluginServerNames(['weather']);
      expect(classifyPluginTool('weather__get_forecast')).toBe('state-changing');
    });

    it('defaults to state-changing even for innocuous-looking read verbs', () => {
      // We cannot know what third-party code does. A tool named `get_*` may
      // still POST. Conservative by default is the whole point of this module.
      setPluginServerNames(['weather']);
      expect(classifyPluginTool('weather__list_items')).toBe('state-changing');
      expect(classifyPluginTool('weather__read_config')).toBe('state-changing');
    });

    it('returns null for non-namespaced (builtin) tool names', () => {
      setPluginServerNames(['weather']);
      expect(classifyPluginTool('read_file')).toBeNull();
    });

    it('does not treat a server whose name merely starts with a plugin name as that plugin', () => {
      setPluginServerNames(['weather']);
      expect(classifyPluginTool('weather-evil__exfiltrate')).toBeNull();
    });

    it('splits on the first separator so tool names containing __ still resolve', () => {
      setPluginServerNames(['weather']);
      expect(classifyPluginTool('weather__deep__nested_tool')).toBe('state-changing');
    });

    it('never claims the browser servers — those keep their own policy', () => {
      setPluginServerNames(['abu-browser']);
      // Even if a malicious manifest names its server `abu-browser`, this module
      // must not shadow the dedicated browser policy.
      expect(classifyPluginTool('abu-browser__click')).toBeNull();
      expect(classifyPluginTool('abu-browser-bridge__click')).toBeNull();
    });
  });

  describe('server-name registry', () => {
    it('replaces the whole set on setPluginServerNames', () => {
      setPluginServerNames(['a', 'b']);
      setPluginServerNames(['c']);
      expect([...getPluginServerNames()]).toEqual(['c']);
    });

    it('exposes a read-only view', () => {
      setPluginServerNames(['a']);
      const view = getPluginServerNames();
      expect(view.has('a')).toBe(true);
      expect(view.size).toBe(1);
    });
  });

  describe('conversation grants', () => {
    it('has no grant before one is minted', () => {
      expect(hasPluginGrant('conv-1', 'weather')).toBe(false);
    });

    it('grants per (conversation, server) pair', () => {
      grantPluginServer('conv-1', 'weather');
      expect(hasPluginGrant('conv-1', 'weather')).toBe(true);
      // A grant for one plugin must not unlock another plugin.
      expect(hasPluginGrant('conv-1', 'other')).toBe(false);
      // Nor another conversation.
      expect(hasPluginGrant('conv-2', 'weather')).toBe(false);
    });

    it('expires the grant after the TTL', () => {
      const t0 = 1_000_000;
      grantPluginServer('conv-1', 'weather', t0);
      expect(hasPluginGrant('conv-1', 'weather', t0 + PLUGIN_GRANT_TTL_MS - 1)).toBe(true);
      expect(hasPluginGrant('conv-1', 'weather', t0 + PLUGIN_GRANT_TTL_MS)).toBe(false);
    });

    it('returns false when the conversation id is unknown', () => {
      grantPluginServer(undefined, 'weather');
      expect(hasPluginGrant(undefined, 'weather')).toBe(false);
    });

    it('drops grants for a server once it is no longer plugin-contributed', () => {
      // Uninstalling a plugin must not leave a live grant that a re-installed
      // plugin of the same name could silently ride.
      setPluginServerNames(['weather']);
      grantPluginServer('conv-1', 'weather');
      setPluginServerNames([]);
      expect(hasPluginGrant('conv-1', 'weather')).toBe(false);
    });
  });
});
