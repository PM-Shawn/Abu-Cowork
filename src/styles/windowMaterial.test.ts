// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { installWindowMaterial } from './windowMaterial';

type ShellWindow = Window & { __ABU_SHELL__?: { windowMaterial?: string } };

describe('installWindowMaterial', () => {
  const root = document.documentElement;
  afterEach(() => {
    delete (window as ShellWindow).__ABU_SHELL__;
    root.removeAttribute('data-window-material');
  });

  it('writes the material the Electron shell reports', () => {
    (window as ShellWindow).__ABU_SHELL__ = { windowMaterial: 'vibrancy' };
    expect(installWindowMaterial(root)).toBe('vibrancy');
    expect(root.getAttribute('data-window-material')).toBe('vibrancy');
  });

  it('treats a page outside the Electron shell as having no material', () => {
    expect(installWindowMaterial(root)).toBe('none');
    expect(root.getAttribute('data-window-material')).toBe('none');
  });

  it('refuses a value the shell never sends', () => {
    (window as ShellWindow).__ABU_SHELL__ = { windowMaterial: 'acrylic' };
    expect(() => installWindowMaterial(root)).toThrow(/window material/);
  });
});
