import { describe, it, expect } from 'vitest';
import { getPermissionStrategy, type PermissionMode } from './permissionMode';
import type { ConfirmationInfo } from '../tools/registry';

const cmd = (level: ConfirmationInfo['level']): ConfirmationInfo => ({ command: 'x', level, reason: '' });

describe('permissionMode', () => {
  describe('standard mode', () => {
    const s = getPermissionStrategy('standard');

    it('read-only commands auto-proceed', () => {
      expect(s.decideCommand(cmd('danger'), true)).toBe('allow');
      expect(s.decideCommand(cmd('safe'), true)).toBe('allow');
    });

    it('safe non-read commands auto-proceed', () => {
      expect(s.decideCommand(cmd('safe'), false)).toBe('allow');
    });

    it('warn/danger commands require confirmation', () => {
      expect(s.decideCommand(cmd('warn'), false)).toBe('confirm');
      expect(s.decideCommand(cmd('danger'), false)).toBe('confirm');
    });

    it('safe command writing outside workspace requires confirmation', () => {
      expect(s.decideCommand(cmd('safe'), false, 'outside')).toBe('confirm');
      expect(s.decideCommand(cmd('safe'), false, 'inside')).toBe('allow');
      expect(s.decideCommand(cmd('safe'), false, 'unknown')).toBe('allow');
    });

    it('access to new (unauthorized) paths requires confirmation', () => {
      expect(s.decideFileAccess('read', true)).toBe('confirm');
      expect(s.decideFileAccess('write', true)).toBe('confirm');
    });

    it('access inside authorized dirs auto-proceeds', () => {
      expect(s.decideFileAccess('read', false)).toBe('allow');
      expect(s.decideFileAccess('write', false)).toBe('allow');
    });

    it('other tools auto-proceed', () => {
      expect(s.decideOtherTool()).toBe('allow');
    });
  });

  describe('smart mode', () => {
    const s = getPermissionStrategy('smart');

    it('escalating commands route to review', () => {
      expect(s.decideCommand(cmd('warn'), false)).toBe('review');
      expect(s.decideCommand(cmd('danger'), false)).toBe('review');
    });

    it('safe / read-only commands auto-proceed', () => {
      expect(s.decideCommand(cmd('safe'), false)).toBe('allow');
      expect(s.decideCommand(cmd('danger'), true)).toBe('allow');
    });

    it('safe command writing outside workspace routes to review', () => {
      expect(s.decideCommand(cmd('safe'), false, 'outside')).toBe('review');
      expect(s.decideCommand(cmd('safe'), false, 'inside')).toBe('allow');
    });

    it('new-path access routes to review', () => {
      expect(s.decideFileAccess('read', true)).toBe('review');
      expect(s.decideFileAccess('write', true)).toBe('review');
    });

    it('access inside authorized dirs auto-proceeds', () => {
      expect(s.decideFileAccess('write', false)).toBe('allow');
    });
  });

  describe('autonomous mode', () => {
    const s = getPermissionStrategy('autonomous');

    it('all commands auto-proceed (block enforced upstream)', () => {
      expect(s.decideCommand(cmd('danger'), false)).toBe('allow');
      expect(s.decideCommand(cmd('warn'), false)).toBe('allow');
      expect(s.decideCommand(cmd('safe'), false, 'outside')).toBe('allow');
    });

    it('all file access auto-proceeds (sensitive paths hard-blocked upstream)', () => {
      expect(s.decideFileAccess('write', true)).toBe('allow');
      expect(s.decideFileAccess('read', true)).toBe('allow');
    });

    it('other tools auto-proceed', () => {
      expect(s.decideOtherTool()).toBe('allow');
    });
  });

  describe('getPermissionStrategy', () => {
    it('unknown mode falls back to standard behavior', () => {
      const s = getPermissionStrategy('bogus' as PermissionMode);
      expect(s.decideCommand(cmd('danger'), false)).toBe('confirm');
      expect(s.decideFileAccess('write', true)).toBe('confirm');
    });
  });
});
