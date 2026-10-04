import { useState, useMemo, useRef } from 'react';
import { useI18n, format } from '@/i18n';
import SettingsSectionHeader from '@/components/settings/SettingsSectionHeader';
import { localDateOf } from '@/core/llm/usageAccounting';
import {
  getUsageSendFailures,
  type UsageAggregate,
  type UsageRangeResult,
} from '@/core/usage/usageLedgerClient';
import { useUsageLedger, type UsagePeriod } from '@/core/usage/useUsageLedger';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * 一个合计数字的显示值。这段时间里有请求、却一次都没取到这个数字时显示「—」：
 * 0 的意思是确实没有消耗，取不到是另一回事（企业网关上的 Claude 整段输入总量
 * 都判为未知，就是这种情况）。
 */
function formatKnownSum(sum: number, unknownAttempts: number, attempts: number): string {
  if (attempts > 0 && unknownAttempts === attempts) return '—';
  return formatTokens(sum);
}

/** 每日 token 总量：已知的输入加已知的输出，未知的不参与。 */
function buildDateTokenMap(daily: UsageRangeResult): Map<string, number> {
  const map = new Map<string, number>();
  for (const day of daily.byDay) {
    const total = day.inputKnownSum + day.outputKnownSum;
    if (total > 0) map.set(day.localDate, total);
  }
  return map;
}

/** 排序用的一行总量。 */
function rowTokens(row: UsageAggregate): number {
  return row.inputKnownSum + row.outputKnownSum;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatRate(num: number, den: number): string {
  if (den === 0) return '—';
  return `${Math.round((num / den) * 100)}%`;
}

const HEAT_COLORS = [
  'bg-[var(--abu-border)]',
  'bg-[#fde8d8]',
  'bg-[#f9c4a0]',
  'bg-[#f09060]',
  'bg-[var(--abu-clay)]',
] as const;

function heatLevel(tokens: number, maxTokens: number): number {
  if (tokens === 0 || maxTokens === 0) return 0;
  const ratio = tokens / maxTokens;
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  if (ratio <= 0.75) return 3;
  return 4;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function KpiCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-[var(--abu-border)] bg-[var(--abu-bg-card)] px-4 py-3 flex flex-col gap-1">
      <span className="text-caption text-[var(--abu-text-tertiary)] leading-none">{label}</span>
      <span className="text-h-md font-semibold text-[var(--abu-text-primary)] tabular-nums leading-tight">{value}</span>
      {/* 占位行，只为四张卡片高度一致，不放文字 */}
      <span className="text-caption text-[var(--abu-text-muted)] leading-none min-h-[12px]">{' '}</span>
    </div>
  );
}

function BarRow({ label, tokens, maxTokens }: { label: string; tokens: number; maxTokens: number }) {
  const pct = maxTokens > 0 ? Math.max(2, Math.round((tokens / maxTokens) * 100)) : 0;
  return (
    <div className="flex items-center gap-2 min-w-0">
      <span className="w-28 shrink-0 text-minor text-[var(--abu-text-secondary)] truncate" title={label}>{label}</span>
      <div className="flex-1 h-1.5 rounded-full bg-[var(--abu-border)] overflow-hidden">
        <div className="h-full rounded-full bg-[var(--abu-clay-60)] transition-all duration-300" style={{ width: `${pct}%` }} />
      </div>
      <span className="w-10 text-right shrink-0 text-caption text-[var(--abu-text-tertiary)] tabular-nums">{formatTokens(tokens)}</span>
    </div>
  );
}

function FloatingTooltip({ hover }: { hover: { text: string; top: number; left: number } | null }) {
  if (!hover) return null;
  return (
    <div
      className="absolute z-50 px-2 py-1 text-caption bg-[#1f1d18] text-white rounded-md shadow-lg pointer-events-none whitespace-nowrap -translate-x-1/2 -translate-y-full"
      style={{ top: hover.top, left: hover.left }}
    >
      {hover.text}
    </div>
  );
}

// 52-week GitHub-style heatmap, full-width
function UsageHeatmap({ dateTokenMap }: { dateTokenMap: Map<string, number> }) {
  const { t } = useI18n();
  const today = new Date();
  const todayStr = localDateOf(today);
  const containerRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ text: string; top: number; left: number } | null>(null);

  // Start from the Monday 51 weeks before the current week's Monday → 52 weeks total
  const dowToday = (today.getDay() + 6) % 7; // Mon=0, Sun=6
  const startDate = new Date(today);
  startDate.setDate(today.getDate() - dowToday - 51 * 7);

  // 364 cells (52 cols × 7 rows)
  const cells: { date: string; isFuture: boolean }[] = [];
  for (let i = 0; i < 364; i++) {
    const d = new Date(startDate);
    d.setDate(startDate.getDate() + i);
    const dateStr = localDateOf(d);
    cells.push({ date: dateStr, isFuture: dateStr > todayStr });
  }

  // Use historical max (all days except today) as baseline so today doesn't dominate.
  // If no history exists yet, fall back to 4× today's tokens so it renders at level 1 (faintest).
  const historyMax = Math.max(
    ...cells.filter(c => c.date !== todayStr).map(c => dateTokenMap.get(c.date) ?? 0),
    0,
  );
  const maxTokens = historyMax > 0
    ? historyMax
    : Math.max(...cells.map(c => dateTokenMap.get(c.date) ?? 0), 1) * 4;

  const weekdays = t.usage.heatmapWeekdays;
  const CELL = 13; // px — fixed square cell size

  return (
    <div ref={containerRef} className="space-y-2 relative">
      <FloatingTooltip hover={hover} />
      <div className="flex items-center justify-between">
        <h3 className="text-caption font-medium text-[var(--abu-text-tertiary)] uppercase tracking-wider">
          {t.usage.heatmapTitle}
        </h3>
        <div className="flex items-center gap-1">
          <span className="text-caption text-[var(--abu-text-muted)]">{t.usage.heatmapLegendLess}</span>
          {HEAT_COLORS.map((cls, i) => (
            <div key={i} className={`h-2.5 w-2.5 rounded-[2px] ${cls}`} />
          ))}
          <span className="text-caption text-[var(--abu-text-muted)]">{t.usage.heatmapLegendMore}</span>
        </div>
      </div>
      <div className="flex gap-1 overflow-x-auto overlay-scroll">
        {/* Weekday labels — same height as cells so they align */}
        <div className="flex flex-col shrink-0" style={{ gap: '2px' }}>
          {weekdays.map((wd, i) => (
            <span
              key={wd}
              className="flex items-center text-caption text-[var(--abu-text-muted)]"
              style={{ height: `${CELL}px`, width: '12px', opacity: i % 2 === 0 ? 1 : 0 }}
            >{wd}</span>
          ))}
        </div>
        {/* 52 week columns — fixed CELL×CELL squares, not stretched */}
        <div className="flex gap-[2px]">
          {Array.from({ length: 52 }, (_, col) => (
            <div key={col} className="flex flex-col shrink-0" style={{ gap: '2px', width: `${CELL}px` }}>
              {Array.from({ length: 7 }, (_, row) => {
                const cell = cells[col * 7 + row];
                const tokens = cell.isFuture ? 0 : (dateTokenMap.get(cell.date) ?? 0);
                const level = cell.isFuture ? 0 : heatLevel(tokens, maxTokens);
                const dotDate = cell.date.replace(/-/g, '.');
                const tooltip = cell.isFuture
                  ? ''
                  : tokens > 0
                    ? format(t.usage.heatmapTooltipUsed, { date: dotDate, tokens: formatTokens(tokens) })
                    : format(t.usage.heatmapTooltipNoData, { date: dotDate });
                return (
                  <div
                    key={cell.date}
                    onMouseEnter={(e) => {
                      if (!tooltip || !containerRef.current) return;
                      const r = e.currentTarget.getBoundingClientRect();
                      const c = containerRef.current.getBoundingClientRect();
                      const cellCenter = r.left - c.left + CELL / 2;
                      const halfTooltip = 110; // approx, prevents right-edge clipping
                      const clampedLeft = Math.max(halfTooltip, Math.min(c.width - halfTooltip, cellCenter));
                      setHover({
                        text: tooltip,
                        top: r.top - c.top - 4,
                        left: clampedLeft,
                      });
                    }}
                    onMouseLeave={() => setHover(null)}
                    style={{ height: `${CELL}px`, width: `${CELL}px` }}
                    className={`rounded-[2px] shrink-0 ${HEAT_COLORS[level]} ${cell.isFuture ? 'opacity-0' : ''}`}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function UsageDailyBar({ dateTokenMap }: { dateTokenMap: Map<string, number> }) {
  const { t } = useI18n();
  const today = new Date();
  const containerRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ text: string; top: number; left: number } | null>(null);

  const days = useMemo(() => {
    return Array.from({ length: 30 }, (_, i) => {
      const d = new Date(today);
      d.setDate(today.getDate() - (29 - i));
      const date = localDateOf(d);
      return { date, tokens: dateTokenMap.get(date) ?? 0 };
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateTokenMap]);

  const maxTokens = Math.max(...days.map(d => d.tokens), 1);

  return (
    <div ref={containerRef} className="space-y-1.5 relative">
      <FloatingTooltip hover={hover} />
      <h3 className="text-caption font-medium text-[var(--abu-text-tertiary)] uppercase tracking-wider">
        {t.usage.dailyTitle}
      </h3>
      <div className="flex items-end gap-[3px] h-24">
        {days.map(({ date, tokens }) => {
          const dotDate = date.replace(/-/g, '.');
          const tip = tokens > 0
            ? format(t.usage.heatmapTooltipUsed, { date: dotDate, tokens: formatTokens(tokens) })
            : format(t.usage.heatmapTooltipNoData, { date: dotDate });
          return (
            <div
              key={date}
              onMouseEnter={(e) => {
                if (!containerRef.current) return;
                const r = e.currentTarget.getBoundingClientRect();
                const c = containerRef.current.getBoundingClientRect();
                const center = r.left - c.left + r.width / 2;
                const halfTooltip = 110;
                const clampedLeft = Math.max(halfTooltip, Math.min(c.width - halfTooltip, center));
                setHover({
                  text: tip,
                  top: r.top - c.top - 4,
                  left: clampedLeft,
                });
              }}
              onMouseLeave={() => setHover(null)}
              className="flex-1 rounded-t-[2px] bg-[var(--abu-clay-60)] opacity-70 hover:opacity-100 transition-opacity"
              style={{ height: `${Math.max(tokens > 0 ? 6 : 1, Math.round((tokens / maxTokens) * 100))}%` }}
            />
          );
        })}
      </div>
      <div className="flex justify-between text-caption text-[var(--abu-text-muted)]">
        <span>{days[0].date.slice(5).replace('-', '/')}</span>
        <span>{days[29].date.slice(5).replace('-', '/')}</span>
      </div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

/**
 * 统计起点与记账健康：一行文字，说清这份统计从哪天开始、有没有漏记。
 *
 * 设置页不放大段文字，所以三件事挤进同一行：起点、本次运行未能记录的次数、
 * 以及读取失败时的「暂未更新」。
 */
function UsageLedgerNote({
  statsOrigin,
  health,
  stale,
  unknownAttempts,
}: {
  statsOrigin: string | null;
  health: UsageRangeResult['health'];
  stale: boolean;
  unknownAttempts: number;
}) {
  const { t } = useI18n();
  // 三处加在一起：主进程写失败的、主进程校验拒绝的、renderer 这一侧没送到的。
  const unrecorded = health.writeFailures + health.rejectedFrames + getUsageSendFailures();
  const parts: string[] = [
    statsOrigin ? format(t.usage.statsOrigin, { date: statsOrigin.replace(/-/g, '.') }) : t.usage.statsOriginEmpty,
  ];
  if (health.degradedCode) parts.push(t.usage.unavailable);
  if (unrecorded > 0) parts.push(format(t.usage.unrecorded, { count: String(unrecorded) }));
  // 只在真有漏掉时出现。全都取到的时候这一句不该占地方。
  if (unknownAttempts > 0) parts.push(format(t.usage.unknownUsage, { count: String(unknownAttempts) }));
  if (stale) parts.push(t.usage.stale);

  return (
    <p className="text-caption text-[var(--abu-text-muted)]">{parts.join(' · ')}</p>
  );
}

export default function UsageSection() {
  const { t } = useI18n();
  const [period, setPeriod] = useState<UsagePeriod>('all');
  const { period: data, daily, stale } = useUsageLedger(period);

  const periods: { id: UsagePeriod; label: string }[] = [
    { id: 'all', label: t.usage.periodAll },
    { id: 'month', label: t.usage.periodMonth },
    { id: 'week', label: t.usage.periodWeek },
    { id: 'today', label: t.usage.periodToday },
  ];

  const dateTokenMap = useMemo(() => buildDateTokenMap(daily), [daily]);

  const totals = data.totals;
  const byModel = useMemo(
    () => [...data.byModel].sort((a, b) => rowTokens(b) - rowTokens(a)),
    [data.byModel],
  );
  const bySkill = useMemo(
    () => [...data.bySkill].sort((a, b) => rowTokens(b) - rowTokens(a)),
    [data.bySkill],
  );
  const maxModelTokens = byModel[0] ? rowTokens(byModel[0]) : 0;
  const maxSkillTokens = bySkill[0] ? rowTokens(bySkill[0]) : 0;

  return (
    <div className="space-y-5">
      <SettingsSectionHeader title={t.usage.title} />

      <UsageLedgerNote
        statsOrigin={data.statsOriginLocalDate}
        health={data.health}
        stale={stale}
        unknownAttempts={Math.max(totals.inputUnknownAttempts, totals.outputUnknownAttempts)}
      />

      {/* Period switcher */}
      <div className="flex gap-1">
        {periods.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => setPeriod(id)}
            className={`px-3 py-1 rounded-md text-minor font-medium transition-colors focus:outline-none focus-visible:outline-none focus-visible:ring-0 ${
              period === id
                ? 'bg-[var(--abu-clay-bg)] text-[var(--abu-clay)] border border-[var(--abu-clay-20)]'
                : 'text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-hover)]'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Row 1 — KPI cards (period-filtered) */}
      <div className="grid grid-cols-4 gap-3">
        <KpiCard label={t.usage.requests} value={String(totals.attempts)} />
        <KpiCard
          label={t.usage.inputTokens}
          value={formatKnownSum(totals.inputKnownSum, totals.inputUnknownAttempts, totals.attempts)}
        />
        <KpiCard
          label={t.usage.outputTokens}
          value={formatKnownSum(totals.outputKnownSum, totals.outputUnknownAttempts, totals.attempts)}
        />
        <KpiCard
          label={t.usage.cacheHitRate}
          // 命中率只在缓存读与输入总量都已知的那些尝试上计算。一次都算不出来时
          // formatRate 给出「—」，本身就说明了没有可比的数据。
          value={formatRate(totals.cacheReadComparableSum, totals.inputComparableSum)}
        />
      </div>

      {/* Row 2 — Full-width 52-week heatmap */}
      <UsageHeatmap dateTokenMap={dateTokenMap} />

      {/* Row 3 — Full-width 30-day bar */}
      <UsageDailyBar dateTokenMap={dateTokenMap} />

      {/* Row 4 — By Model + By Skill (period-filtered) */}
      <div className="grid grid-cols-2 gap-6">
        <div className="space-y-2">
          <h3 className="text-caption font-medium text-[var(--abu-text-tertiary)] uppercase tracking-wider">{t.usage.byModel}</h3>
          {byModel.length === 0
            ? <p className="text-minor text-[var(--abu-text-muted)] py-1">—</p>
            : <div className="space-y-2">{byModel.slice(0, 10).map(item => <BarRow key={item.requestedModel} label={item.requestedModel} tokens={rowTokens(item)} maxTokens={maxModelTokens} />)}</div>
          }
        </div>
        <div className="space-y-2">
          <h3 className="text-caption font-medium text-[var(--abu-text-tertiary)] uppercase tracking-wider">{t.usage.bySkill}</h3>
          {bySkill.length === 0
            ? <p className="text-minor text-[var(--abu-text-muted)] py-1">—</p>
            : <div className="space-y-2">{bySkill.slice(0, 10).map(item => <BarRow key={item.skill} label={item.skill} tokens={rowTokens(item)} maxTokens={maxSkillTokens} />)}</div>
          }
        </div>
      </div>
    </div>
  );
}
