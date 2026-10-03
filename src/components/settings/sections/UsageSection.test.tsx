// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
import { localDateOf } from '@/core/llm/usageAccounting';
import {
  emptyUsageAggregate,
  emptyUsageRangeResult,
  type UsageAggregate,
  type UsageRangeResult,
} from '@/core/usage/usageLedgerClient';
import type { UsageLedgerView, UsagePeriod } from '@/core/usage/useUsageLedger';
import { initLanguage } from '@/i18n';
import UsageSection from './UsageSection';

// The page's only data source, answered from what the test puts in `ledger`.
const ledger = vi.hoisted(() => ({
  periods: [] as string[],
  view: null as unknown,
  sendFailures: 0,
}));
vi.mock('@/core/usage/useUsageLedger', () => ({
  useUsageLedger: (period: string) => {
    ledger.periods.push(period);
    return ledger.view;
  },
}));
vi.mock('@/core/usage/usageLedgerClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/core/usage/usageLedgerClient')>()),
  getUsageSendFailures: () => ledger.sendFailures,
}));

// A Friday at noon, local time.
const NOW = new Date(2026, 9, 2, 12, 0, 0);
function daysAgo(days: number): string {
  const day = new Date(NOW);
  day.setDate(day.getDate() - days);
  return localDateOf(day);
}

const aggregate = (fields: Partial<UsageAggregate>): UsageAggregate => ({ ...emptyUsageAggregate(), ...fields });
const range = (fields: Partial<UsageRangeResult>): UsageRangeResult => ({ ...emptyUsageRangeResult(), available: true, ...fields });
function setLedger(period: Partial<UsageRangeResult>, daily: Partial<UsageRangeResult> = {}, stale = false) {
  const view: UsageLedgerView = { period: range(period), daily: range(daily), stale, refresh: () => undefined };
  ledger.view = view;
}
const day = (localDate: string, tokens: number) => ({ ...aggregate({ attempts: 1, inputKnownSum: tokens }), localDate });

const show = () => render(<UsageSection />, { wrapper: DesignSystemProvider });
// One of the four time ranges.
const periodControl = (name: string) => screen.getByRole('radio', { name });
const lastPeriod = (): UsagePeriod => ledger.periods[ledger.periods.length - 1] as UsagePeriod;
// The big number of one of the four cards, found from the card's label.
const cardValue = (label: string) => (screen.getByText(label).nextElementSibling as HTMLElement).textContent;

// The legend shows the five shades from none to most, in order. A day's level is the place of
// its shade among them.
function legendShades(): string[] {
  const legend = screen.getByText('少').parentElement as HTMLElement;
  return [...legend.querySelectorAll('div')].map((swatch) => {
    const shade = [...swatch.classList].find((name) => name.startsWith('bg-'));
    if (!shade) throw new Error('A legend swatch has no shade');
    return shade;
  });
}
// The 364 day squares, oldest first (52 weeks, each a column from Monday to Sunday).
const daySquares = () => [...document.querySelectorAll<HTMLElement>('div[style*="height: 13px"][style*="width: 13px"]')];
function levelOf(localDate: string): number {
  // Monday of the week 51 weeks before this one.
  const start = new Date(NOW);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7) - 51 * 7);
  const index = Math.round((new Date(`${localDate}T12:00:00`).getTime() - start.getTime()) / 86_400_000);
  const square = daySquares()[index];
  return legendShades().findIndex((shade) => square.classList.contains(shade));
}
// The names of one ranking, top to bottom.
function ranking(title: string): string[] {
  const column = screen.getByRole('heading', { name: title }).parentElement as HTMLElement;
  return [...column.querySelectorAll('[title]')].map((label) => label.getAttribute('title') ?? '');
}

describe('UsageSection', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    initLanguage('zh-CN');
    ledger.periods = [];
    ledger.sendFailures = 0;
    setLedger({});
  });
  afterEach(() => { vi.useRealTimers(); });

  describe('the time range', () => {
    it('starts on 全部 and asks the ledger for the range that was pressed', async () => {
      const user = userEvent.setup();
      show();
      expect(lastPeriod()).toBe('all');
      for (const [name, period] of [['本月', 'month'], ['本周', 'week'], ['今日', 'today'], ['全部', 'all']] as const) {
        await user.click(periodControl(name));
        expect(lastPeriod()).toBe(period);
      }
    });

    it('lists the four ranges in order', () => {
      show();
      const names = ['全部', '本月', '本周', '今日'];
      const controls = names.map(periodControl);
      for (let index = 1; index < controls.length; index += 1) {
        expect(controls[index - 1].compareDocumentPosition(controls[index]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      }
    });
  });

  describe('the page', () => {
    it('keeps its title and the order of its parts', () => {
      show();
      const parts = [
        screen.getByRole('heading', { level: 3, name: '用量' }),
        screen.getByText('还没有记录'),
        periodControl('全部'),
        screen.getByText('请求尝试'),
        screen.getByRole('heading', { name: '活跃热图（近 1 年）' }),
        screen.getByRole('heading', { name: '每日消耗（近 30 天）' }),
        screen.getByRole('heading', { name: '按 Model' }),
        screen.getByRole('heading', { name: '按 Skill' }),
      ];
      for (let index = 1; index < parts.length; index += 1) {
        expect(parts[index - 1].compareDocumentPosition(parts[index]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      }
    });
  });

  describe('the four numbers', () => {
    it('shows the count, both token sums shortened, and the cache hit rate', () => {
      setLedger({
        totals: aggregate({
          attempts: 12, inputKnownSum: 1_234_567, outputKnownSum: 2_345, cacheReadComparableSum: 1, inputComparableSum: 3,
        }),
      });
      show();
      expect(cardValue('请求尝试')).toBe('12');
      expect(cardValue('输入 token')).toBe('1.2M');
      expect(cardValue('输出 token')).toBe('2.3k');
      expect(cardValue('缓存命中率')).toBe('33%');
    });

    it('shows small sums as they are and zero as zero', () => {
      setLedger({ totals: aggregate({ attempts: 2, inputKnownSum: 999, outputKnownSum: 0 }) });
      show();
      expect(cardValue('输入 token')).toBe('999');
      expect(cardValue('输出 token')).toBe('0');
    });

    it('shows a dash for a sum no request reported, and for a rate with nothing to compare', () => {
      setLedger({
        totals: aggregate({ attempts: 3, inputKnownSum: 0, inputUnknownAttempts: 3, outputKnownSum: 50, outputUnknownAttempts: 1 }),
      });
      show();
      expect(cardValue('输入 token')).toBe('—');
      expect(cardValue('输出 token')).toBe('50');
      expect(cardValue('缓存命中率')).toBe('—');
    });
  });

  describe('the ledger note', () => {
    it('says where the statistics start', () => {
      setLedger({ statsOriginLocalDate: '2026-09-15' });
      show();
      expect(screen.getByText('统计从 2026.09.15 开始，更早的记录不完整，未并入')).toBeInTheDocument();
    });

    it('adds how many requests reported no usage: the larger of the two counts', () => {
      setLedger({
        statsOriginLocalDate: '2026-09-15',
        totals: aggregate({ attempts: 5, inputUnknownAttempts: 1, outputUnknownAttempts: 2 }),
      });
      show();
      expect(screen.getByText('统计从 2026.09.15 开始，更早的记录不完整，未并入 · 另有 2 次未取到用量')).toBeInTheDocument();
    });

    it('adds every problem in one line: ledger stopped, requests not recorded, not updated', () => {
      ledger.sendFailures = 1;
      const health = { ...emptyUsageRangeResult().health, writeFailures: 2, rejectedFrames: 3, degradedCode: 'open_failed' };
      setLedger({ health }, {}, true);
      show();
      expect(screen.getByText('还没有记录 · 用量暂时记不上，聊天不受影响 · 有 6 次请求未能记录，统计可能不完整 · 暂未更新')).toBeInTheDocument();
    });
  });

  describe('the two rankings', () => {
    const models = Array.from({ length: 12 }, (_, index) => ({
      ...aggregate({ attempts: 1, inputKnownSum: (index + 1) * 100, outputKnownSum: 10 }),
      requestedModel: `model-${index + 1}`,
    }));
    const skills = Array.from({ length: 11 }, (_, index) => ({
      ...aggregate({ attempts: 1, outputKnownSum: (index + 1) * 1000 }),
      skill: `skill-${index + 1}`,
    }));

    it('shows at most ten of each, the largest first', () => {
      // Handed over smallest first.
      setLedger({ byModel: models, bySkill: skills });
      show();
      expect(ranking('按 Model')).toEqual(['model-12', 'model-11', 'model-10', 'model-9', 'model-8', 'model-7', 'model-6', 'model-5', 'model-4', 'model-3']);
      expect(ranking('按 Skill')).toEqual(['skill-11', 'skill-10', 'skill-9', 'skill-8', 'skill-7', 'skill-6', 'skill-5', 'skill-4', 'skill-3', 'skill-2']);
      // Input plus output, shortened.
      expect(screen.getByText('model-12').parentElement).toHaveTextContent('model-121.2k');
      expect(screen.getByText('skill-11').parentElement).toHaveTextContent('skill-1111.0k');
    });

    it('shows a dash for a ranking with nothing in it', () => {
      setLedger({ byModel: models });
      show();
      expect(ranking('按 Skill')).toEqual([]);
      expect(screen.getByRole('heading', { name: '按 Skill' }).parentElement).toHaveTextContent('按 Skill—');
    });
  });

  describe('the year of days', () => {
    it('has 364 days and five shades, all different', () => {
      show();
      expect(daySquares()).toHaveLength(364);
      expect(new Set(legendShades()).size).toBe(5);
    });

    // The busiest earlier day sets the scale: 1000 tokens.
    it.each([
      [0, 0],
      [250, 1],
      [500, 2],
      [750, 3],
      [1000, 4],
    ])('a day with %i of the busiest day\'s 1000 tokens is level %i', (tokens, level) => {
      const byDay = [day(daysAgo(20), 1000)];
      if (tokens > 0 && tokens < 1000) byDay.push(day(daysAgo(10), tokens));
      setLedger({}, { byDay });
      show();
      expect(levelOf(tokens === 1000 ? daysAgo(20) : daysAgo(10))).toBe(level);
    });

    it.each([
      [251, 2],
      [501, 3],
      [751, 4],
    ])('just over a quarter step, %i tokens is level %i', (tokens, level) => {
      setLedger({}, { byDay: [day(daysAgo(20), 1000), day(daysAgo(10), tokens)] });
      show();
      expect(levelOf(daysAgo(10))).toBe(level);
    });

    it('does not let today set the scale: with no earlier use, today is the faintest shade', () => {
      setLedger({}, { byDay: [day(daysAgo(0), 5000)] });
      show();
      expect(levelOf(daysAgo(0))).toBe(1);
    });

    it('counts input and output of a day together', () => {
      const both = { ...aggregate({ attempts: 2, inputKnownSum: 300, outputKnownSum: 300 }), localDate: daysAgo(10) };
      setLedger({}, { byDay: [day(daysAgo(20), 1000), both] });
      show();
      expect(levelOf(daysAgo(10))).toBe(3);
    });

    it('says what a day used when the pointer is on it, and stops when it leaves', () => {
      setLedger({}, { byDay: [day(daysAgo(20), 1500)] });
      show();
      const start = new Date(NOW);
      start.setDate(start.getDate() - ((start.getDay() + 6) % 7) - 51 * 7);
      const used = daySquares().find((square) => legendShades().indexOf([...square.classList].find((name) => name.startsWith('bg-')) ?? '') === 4) as HTMLElement;
      fireEvent.mouseEnter(used);
      const dotted = daysAgo(20).replace(/-/g, '.');
      expect(screen.getByText(`${dotted} 消耗了 1.5k token`)).toBeInTheDocument();
      fireEvent.mouseLeave(used);
      expect(screen.queryByText(`${dotted} 消耗了 1.5k token`)).toBeNull();

      const idle = daySquares()[0];
      fireEvent.mouseEnter(idle);
      expect(screen.getByText(`${localDateOf(start).replace(/-/g, '.')} 暂无记录`)).toBeInTheDocument();
    });
  });

  describe('the last 30 days', () => {
    // The bars sit between the heading and the two dates under them.
    const bars = () => {
      const chart = screen.getByRole('heading', { name: '每日消耗（近 30 天）' }).nextElementSibling as HTMLElement;
      return [...chart.children] as HTMLElement[];
    };

    it('draws one bar per day, as tall as its share of the busiest of them', () => {
      setLedger({}, { byDay: [day(daysAgo(29), 1000), day(daysAgo(1), 500), day(daysAgo(0), 10), day(daysAgo(40), 9000)] });
      show();
      expect(bars()).toHaveLength(30);
      expect(bars()[0].style.height).toBe('100%');
      expect(bars()[28].style.height).toBe('50%');
      // A day with use is never shorter than 6%, a day without is a 1% line.
      expect(bars()[29].style.height).toBe('6%');
      expect(bars()[1].style.height).toBe('1%');
      expect(screen.getByText(daysAgo(29).slice(5).replace('-', '/'))).toBeInTheDocument();
      expect(screen.getByText(daysAgo(0).slice(5).replace('-', '/'))).toBeInTheDocument();
    });

    it('says what a day used when the pointer is on its bar', () => {
      setLedger({}, { byDay: [day(daysAgo(1), 500)] });
      show();
      fireEvent.mouseEnter(bars()[28]);
      expect(screen.getByText(`${daysAgo(1).replace(/-/g, '.')} 消耗了 500 token`)).toBeInTheDocument();
      fireEvent.mouseLeave(bars()[28]);
      fireEvent.mouseEnter(bars()[0]);
      expect(screen.getByText(`${daysAgo(29).replace(/-/g, '.')} 暂无记录`)).toBeInTheDocument();
    });
  });

  describe('on the design system', () => {
    it('offers the time range as one named choice with the current range checked', () => {
      show();
      expect(screen.getByRole('group', { name: '用量' })).toBeInTheDocument();
      expect(screen.getAllByRole('radio').map((radio) => radio.textContent)).toEqual(['全部', '本月', '本周', '今日']);
      expect(screen.getByRole('radio', { name: '全部' })).toBeChecked();
      expect(screen.getByRole('radio', { name: '本周' })).not.toBeChecked();
    });

    it('moves only the focus on arrow keys; the range changes on Enter or Space', async () => {
      const user = userEvent.setup();
      show();
      screen.getByRole('radio', { name: '全部' }).focus();
      await user.keyboard('{ArrowRight}');
      expect(screen.getByRole('radio', { name: '本月' })).toHaveFocus();
      await user.keyboard('{ArrowRight}');
      expect(screen.getByRole('radio', { name: '本周' })).toHaveFocus();
      expect(new Set(ledger.periods)).toEqual(new Set(['all']));
      expect(screen.getByRole('radio', { name: '全部' })).toBeChecked();

      await user.keyboard('{Enter}');
      expect(lastPeriod()).toBe('week');
      await user.keyboard('{ArrowRight}');
      expect(lastPeriod()).toBe('week');
      await user.keyboard(' ');
      expect(lastPeriod()).toBe('today');
    });

    it('keeps the range when the current one is pressed again', async () => {
      const user = userEvent.setup();
      show();
      await user.click(screen.getByRole('radio', { name: '全部' }));
      expect(screen.getByRole('radio', { name: '全部' })).toBeChecked();
      expect(lastPeriod()).toBe('all');
    });

    it('shades the year in five neutral steps', () => {
      show();
      expect(legendShades()).toEqual(['bg-fill', 'bg-heat-1', 'bg-heat-2', 'bg-heat-3', 'bg-heat-4']);
    });

    it('draws the bars and the ranking tracks in the same neutral steps', () => {
      const models = [{ ...aggregate({ attempts: 1, inputKnownSum: 100 }), requestedModel: 'model-1' }];
      setLedger({ byModel: models }, { byDay: [day(daysAgo(1), 500)] });
      show();
      const chart = screen.getByRole('heading', { name: '每日消耗（近 30 天）' }).nextElementSibling as HTMLElement;
      for (const bar of [...chart.children]) expect(bar).toHaveClass('bg-heat-3');
      const track = screen.getByText('model-1').nextElementSibling as HTMLElement;
      expect(track).toHaveClass('bg-fill');
      expect(track.firstElementChild).toHaveClass('bg-heat-3');
    });

    it('draws the pointer tip as an opaque raised layer inside the page', () => {
      setLedger({}, { byDay: [day(daysAgo(20), 1500)] });
      show();
      fireEvent.mouseEnter(daySquares()[0]);
      const tip = screen.getByText(/暂无记录$/);
      expect(tip).toHaveClass('bg-raised');
      expect(tip).toHaveClass('z-sticky');
      expect(tip).toHaveClass('shadow-float');
      expect(tip).toHaveClass('pointer-events-none');
    });

    it('keeps the ledger note one quiet line', () => {
      ledger.sendFailures = 1;
      setLedger({ health: { ...emptyUsageRangeResult().health, degradedCode: 'open_failed' } }, {}, true);
      show();
      const note = screen.getByText(/^还没有记录 · /);
      expect(note.tagName).toBe('P');
      expect(note).toHaveClass('text-label-tertiary');
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });
});
