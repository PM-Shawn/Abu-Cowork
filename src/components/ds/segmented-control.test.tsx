// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SegmentedControl } from './segmented-control';
import { SEGMENT_SELECTED, SEGMENT_TRACK } from './styles';

afterEach(cleanup);

const OPTIONS = [{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }];

// scripts/designTokens.test.ts holds the contrast of these two fills in every appearance; this
// holds the control to them.
describe('SegmentedControl', () => {
  it.each([false, true])('paints its track and every segment with the guarded fills (fullWidth: %s)', (fullWidth) => {
    render(<SegmentedControl label="Appearance" value="light" onValueChange={() => undefined} options={OPTIONS} fullWidth={fullWidth} />);
    const track = screen.getByRole('group', { name: 'Appearance' });
    expect(track.className.split(' ')).toContain(SEGMENT_TRACK);
    const segments = screen.getAllByRole('radio');
    expect(segments).toHaveLength(OPTIONS.length);
    for (const segment of segments) {
      const fills = segment.className.split(' ').filter((name) => name.includes('bg-'));
      expect(fills).toEqual([SEGMENT_SELECTED]);
    }
  });

  it('marks exactly the chosen segment as on, which is what the selected fill keys off', () => {
    render(<SegmentedControl label="Appearance" value="light" onValueChange={() => undefined} options={OPTIONS} />);
    const states = screen.getAllByRole('radio').map((segment) => [segment.textContent, segment.getAttribute('data-state')]);
    expect(states).toEqual([['System', 'off'], ['Light', 'on'], ['Dark', 'off']]);
    expect(SEGMENT_SELECTED.startsWith('data-[state=on]:')).toBe(true);
  });
});
