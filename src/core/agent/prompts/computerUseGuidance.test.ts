import { describe, it, expect } from 'vitest';
import { commandsFirstGuidance, openingAppsGuidance, structuredComputerUseGuidance } from './computerUseGuidance';

describe('structuredComputerUseGuidance', () => {
  it.each([true, false])('works from window text only (windows=%s)', (windows) => {
    const text = structuredComputerUseGuidance(windows);
    expect(text).toContain('The current model cannot see images');
    expect(text).toContain('cannot be seen by the current model');
    expect(text).toContain(commandsFirstGuidance(windows));
    expect(text).toContain(openingAppsGuidance(windows));
    expect(text).not.toMatch(/screenshot/i);
  });

  it('opens apps with launch_app on Windows and with a command on macOS', () => {
    expect(openingAppsGuidance(true)).toContain('computer(action="launch_app", app="记事本")');
    expect(openingAppsGuidance(false)).toContain('open -a "AppName"');
  });
});
