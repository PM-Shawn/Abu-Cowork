// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Select } from './select';

/**
 * Pin the ONE geometry rule the settings pane depends on: an opened menu is
 * exactly as wide as the trigger that opened it.
 *
 * Before this, a settings-row menu was shrink-to-fit with a `min-width` floor,
 * so the longest option `description` — a single unbroken line — decided how
 * wide it landed. A 185px trigger opened a ~560px menu. Nothing failed; it
 * just looked wrong, in a way no assertion in the suite could see.
 *
 * happy-dom does no layout, so `getBoundingClientRect` is stubbed: the point
 * under test is that the component COPIES the measured width onto the menu,
 * not what a real browser would measure.
 */
const TRIGGER_RECT = { x: 40, y: 100, width: 208, height: 32 };

function stubTriggerRect(): void {
  vi.spyOn(HTMLButtonElement.prototype, 'getBoundingClientRect').mockReturnValue({
    ...TRIGGER_RECT,
    top: TRIGGER_RECT.y,
    left: TRIGGER_RECT.x,
    right: TRIGGER_RECT.x + TRIGGER_RECT.width,
    bottom: TRIGGER_RECT.y + TRIGGER_RECT.height,
    toJSON: () => ({}),
  } as DOMRect);
}

const OPTIONS = [
  { value: 'allow', label: '允许', description: '不再询问' },
  {
    value: 'ask',
    label: '每次询问',
    // Long enough that a shrink-to-fit menu would be several times the
    // trigger's width — this is the string that used to set it.
    description: '你在场时弹窗确认；自动任务发到 IM 频道等你批准',
  },
  { value: 'deny', label: '拒绝', description: '阿布不会做这类操作' },
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Select menu geometry', () => {
  it('opens a settings-row menu exactly as wide as its trigger', async () => {
    const user = userEvent.setup();
    stubTriggerRect();

    render(
      <Select
        variant="inline"
        value="ask"
        options={OPTIONS}
        onChange={() => {}}
        ariaLabel="操作权限"
      />,
    );

    await user.click(screen.getByRole('button', { name: /操作权限/ }));

    const menu = screen.getByRole('button', { name: /允许/ }).parentElement;
    expect(menu).not.toBeNull();
    expect(menu?.style.width).toBe(`${TRIGGER_RECT.width}px`);
    // Left-anchored to the trigger: with equal widths this is also its right
    // edge, so the old right-anchoring is preserved rather than traded away.
    expect(menu?.style.left).toBe(`${TRIGGER_RECT.x}px`);
    // The floor that used to be the only width rule must not come back and
    // out-vote the measured width on a narrower trigger.
    expect(menu?.className).not.toContain('min-w-');
  });

  it('leaves the borderless ghost row shrink-to-fit — its trigger is too narrow to host a menu', async () => {
    const user = userEvent.setup();
    stubTriggerRect();

    render(
      <Select
        variant="ghost"
        value="ask"
        options={OPTIONS}
        onChange={() => {}}
        ariaLabel="快捷设置"
      />,
    );

    await user.click(screen.getByRole('button', { name: /快捷设置/ }));

    const menu = screen.getByRole('button', { name: /允许/ }).parentElement;
    expect(menu?.style.width).toBe('');
    expect(menu?.className).toContain('min-w-[240px]');
  });
});
