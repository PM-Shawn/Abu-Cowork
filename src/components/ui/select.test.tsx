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

  /**
   * The OTHER half of the width fix, and the half no menu assertion can see.
   *
   * `menuHugsTrigger` used to mean two things at once: "the menu copies the
   * trigger's width" AND "the wrapper stretches to its parent". Letting the
   * inline variant hug required splitting them (`stretchesToWrapper`), and the
   * split is only correct because the second flag kept the OLD expression —
   * which is exactly the kind of invariant that holds by code equality and
   * dies silently on the next edit. `GeneralSection`'s three inline Selects
   * sit in a row and must stay content-width; a form field must still fill its
   * field.
   */
  it('stretches only the form-field variant to its wrapper — a settings row sizes itself', () => {
    const { rerender } = render(
      <Select variant="inline" value="ask" options={OPTIONS} onChange={() => {}} ariaLabel="设置行" />,
    );
    expect(screen.getByRole('button', { name: /设置行/ }).parentElement?.className)
      .not.toContain('w-full');

    rerender(
      <Select variant="ghost" value="ask" options={OPTIONS} onChange={() => {}} ariaLabel="快捷行" />,
    );
    expect(screen.getByRole('button', { name: /快捷行/ }).parentElement?.className)
      .not.toContain('w-full');

    rerender(
      <Select value="ask" options={OPTIONS} onChange={() => {}} ariaLabel="表单字段" />,
    );
    expect(screen.getByRole('button', { name: /表单字段/ }).parentElement?.className)
      .toContain('w-full');
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

  /**
   * The rule that makes the line above mean anything.
   *
   * A ghost menu has no measured width, so the browser sizes it from its
   * content. While an option row was `w-full`, that content width was defined
   * in terms of the menu's own width — the row asks for 100% of a box whose
   * size is still being decided — and the browser settles the loop with the
   * space that happens to be available. In the account popover, right-anchored
   * to a 74px trigger 231px from the window edge, that produced a 231px menu
   * with 130px of blank space, hanging past the popover's left edge.
   *
   * Rows fill the menu by stretching inside its flex column instead. happy-dom
   * does no layout, so what is pinned here is the rule, not a measurement.
   */
  it('sizes a ghost menu from its labels — no option row states a percentage width', async () => {
    const user = userEvent.setup();
    stubTriggerRect();

    render(
      <Select variant="ghost" value="ask" options={OPTIONS} onChange={() => {}} ariaLabel="快捷设置" />,
    );

    await user.click(screen.getByRole('button', { name: /快捷设置/ }));

    const menu = screen.getByRole('button', { name: /允许/ }).parentElement;
    expect(menu?.className).toContain('flex-col');
    const rows = menu?.querySelectorAll('button[data-value]') ?? [];
    expect(rows.length).toBe(OPTIONS.length);
    for (const row of rows) {
      expect(row.className).not.toContain('w-full');
    }
  });

  /** Grouped options sit one level deeper, so the group has to stretch its
   *  rows the same way the menu stretches a flat list. */
  it('stretches grouped rows too — each group is a column of its own', async () => {
    const user = userEvent.setup();
    stubTriggerRect();

    render(
      <Select
        variant="inline"
        value="allow"
        options={[
          { label: '常用', options: [OPTIONS[0], OPTIONS[1]] },
          { label: '其他', options: [OPTIONS[2]] },
        ]}
        onChange={() => {}}
        ariaLabel="分组设置"
      />,
    );

    await user.click(screen.getByRole('button', { name: /分组设置/ }));

    const row = screen.getByRole('button', { name: /拒绝/ });
    expect(row.className).not.toContain('w-full');
    expect(row.parentElement?.className).toContain('flex-col');
  });
});
