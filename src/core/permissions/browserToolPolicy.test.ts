import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetBrowserGrantsForTests,
  classifyBrowserTool,
  grantBrowserAutomation,
  hasBrowserGrant,
  revokeBrowserGrant,
} from './browserToolPolicy';

describe('browser tool policy', () => {
  beforeEach(() => {
    __resetBrowserGrantsForTests();
  });

  describe('classifyBrowserTool', () => {
    it('classifies actions that act inside the logged-in session as state-changing', () => {
      for (const tool of ['click', 'fill', 'select', 'keyboard', 'execute_js', 'navigate']) {
        expect(classifyBrowserTool(`abu-browser__${tool}`)).toBe('state-changing');
        expect(classifyBrowserTool(`abu-browser-bridge__${tool}`)).toBe('state-changing');
      }
    });

    it('leaves observation tools ungated', () => {
      for (const tool of ['snapshot', 'get_tabs', 'extract_text', 'extract_table', 'screenshot', 'scroll']) {
        expect(classifyBrowserTool(`abu-browser__${tool}`)).toBe('read-only');
      }
    });

    it('ignores non-browser tools so other MCP servers keep their current behavior', () => {
      expect(classifyBrowserTool('some-server__click')).toBeNull();
      expect(classifyBrowserTool('run_command')).toBeNull();
      expect(classifyBrowserTool('read_file')).toBeNull();
    });

    it('does not let a server name ending in the browser name slip through', () => {
      expect(classifyBrowserTool('evil-abu-browser__click')).toBeNull();
    });
  });

  describe('per-conversation grant', () => {
    it('starts ungranted and grants only the conversation that approved', () => {
      expect(hasBrowserGrant('conv-1')).toBe(false);

      grantBrowserAutomation('conv-1');

      expect(hasBrowserGrant('conv-1')).toBe(true);
      expect(hasBrowserGrant('conv-2')).toBe(false);
    });

    it('treats a missing conversation id as ungranted and ignores granting it', () => {
      grantBrowserAutomation(undefined);
      expect(hasBrowserGrant(undefined)).toBe(false);
    });

    it('drops the grant when revoked', () => {
      grantBrowserAutomation('conv-1');
      revokeBrowserGrant('conv-1');
      expect(hasBrowserGrant('conv-1')).toBe(false);
    });
  });
});
