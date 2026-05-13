import { useState, useMemo, useRef } from 'react';
import { useUsageStatsStore, type DailyRecord } from '@/stores/usageStatsStore';
import { useI18n, format } from '@/i18n';

// ── Helpers ──────────────────────────────────────────────────────────────────

type Period = 'today' | 'week' | 'month' | 'all';

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function currentDate(): string {
  return isoDate(new Date());
}

function getStartDate(period: Period): string {
  const today = currentDate();
  if (period === 'today') return today;
  if (period === 'week') {
    const d = new Date();
    d.setDate(d.getDate() - 6);
    return isoDate(d);
  }
  if (period === 'month') {
    return `${today.slice(0, 7)}-01`;
  }
  return ''; // all
}

interface Aggregated {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  bySkill: { skill: string; requests: number; tokens: number }[];
  byModel: { model: string; requests: number; tokens: number }[];
}

function aggregate(records: DailyRecord[], startDate: string, endDate: string): Aggregated {
  const skillMap = new Map<string, { requests: number; tokens: number }>();
  const modelMap = new Map<string, { requests: number; tokens: number }>();
  let requests = 0, inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheCreationTokens = 0;

  for (const rec of records) {
    if (startDate && rec.date < startDate) continue;
    if (rec.date > endDate) continue;
    for (const e of rec.entries) {
      requests += e.requests;
      inputTokens += e.inputTokens;
      outputTokens += e.outputTokens;
      cacheReadTokens += e.cacheReadTokens;
      cacheCreationTokens += e.cacheCreationTokens;

      const total = e.inputTokens + e.outputTokens;
      if (e.skill) {
        const prev = skillMap.get(e.skill) ?? { requests: 0, tokens: 0 };
        skillMap.set(e.skill, { requests: prev.requests + e.requests, tokens: prev.tokens + total });
      }
      const prevModel = modelMap.get(e.model) ?? { requests: 0, tokens: 0 };
      modelMap.set(e.model, { requests: prevModel.requests + e.requests, tokens: prevModel.tokens + total });
    }
  }

  return {
    requests, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens,
    bySkill: [...skillMap.entries()].map(([skill, v]) => ({ skill, ...v })).sort((a, b) => b.tokens - a.tokens),
    byModel: [...modelMap.entries()].map(([model, v]) => ({ model, ...v })).sort((a, b) => b.tokens - a.tokens),
  };
}

function buildDateTokenMap(records: DailyRecord[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const rec of records) {
    let total = 0;
    for (const e of rec.entries) total += e.inputTokens + e.outputTokens;
    if (total > 0) map.set(rec.date, total);
  }
  return map;
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

function KpiCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-[var(--abu-border)] bg-[var(--abu-bg-card)] px-4 py-3 flex flex-col gap-1">
      <span className="text-[11px] text-[var(--abu-text-tertiary)] leading-none">{label}</span>
      <span className="text-xl font-semibold text-[var(--abu-text-primary)] tabular-nums leading-tight">{value}</span>
      <span className="text-[10px] text-[var(--abu-text-muted)] leading-none min-h-[12px]">{sub ?? ' '}</span>
    </div>
  );
}

function BarRow({ label, tokens, maxTokens }: { label: string; tokens: number; maxTokens: number }) {
  const pct = maxTokens > 0 ? Math.max(2, Math.round((tokens / maxTokens) * 100)) : 0;
  return (
    <div className="flex items-center gap-2 min-w-0">
      <span className="w-28 shrink-0 text-[12px] text-[var(--abu-text-secondary)] truncate" title={label}>{label}</span>
      <div className="flex-1 h-1.5 rounded-full bg-[var(--abu-border)] overflow-hidden">
        <div className="h-full rounded-full bg-[var(--abu-clay-60)] transition-all duration-300" style={{ width: `${pct}%` }} />
      </div>
      <span className="w-10 text-right shrink-0 text-[11px] text-[var(--abu-text-tertiary)] tabular-nums">{formatTokens(tokens)}</span>
    </div>
  );
}

function FloatingTooltip({ hover }: { hover: { text: string; top: number; left: number } | null }) {
  if (!hover) return null;
  return (
    <div
      className="absolute z-50 px-2 py-1 text-[11px] bg-[#1f1d18] text-white rounded-md shadow-lg pointer-events-none whitespace-nowrap -translate-x-1/2 -translate-y-full"
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
  const todayStr = isoDate(today);
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
    const dateStr = isoDate(d);
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
        <h3 className="text-[11px] font-medium text-[var(--abu-text-tertiary)] uppercase tracking-wider">
          {t.usage.heatmapTitle}
        </h3>
        <div className="flex items-center gap-1">
          <span className="text-[9px] text-[var(--abu-text-muted)]">{t.usage.heatmapLegendLess}</span>
          {HEAT_COLORS.map((cls, i) => (
            <div key={i} className={`h-2.5 w-2.5 rounded-[2px] ${cls}`} />
          ))}
          <span className="text-[9px] text-[var(--abu-text-muted)]">{t.usage.heatmapLegendMore}</span>
        </div>
      </div>
      <div className="flex gap-1">
        {/* Weekday labels — same height as cells so they align */}
        <div className="flex flex-col shrink-0" style={{ gap: '2px' }}>
          {weekdays.map((wd, i) => (
            <span
              key={wd}
              className="flex items-center text-[9px] text-[var(--abu-text-muted)]"
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
      const date = isoDate(d);
      return { date, tokens: dateTokenMap.get(date) ?? 0 };
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateTokenMap]);

  const maxTokens = Math.max(...days.map(d => d.tokens), 1);

  return (
    <div ref={containerRef} className="space-y-1.5 relative">
      <FloatingTooltip hover={hover} />
      <h3 className="text-[11px] font-medium text-[var(--abu-text-tertiary)] uppercase tracking-wider">
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
      <div className="flex justify-between text-[9px] text-[var(--abu-text-muted)]">
        <span>{days[0].date.slice(5).replace('-', '/')}</span>
        <span>{days[29].date.slice(5).replace('-', '/')}</span>
      </div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function UsageSection() {
  const { t } = useI18n();
  const records = useUsageStatsStore((s) => s.records);
  const [period, setPeriod] = useState<Period>('all');

  const periods: { id: Period; label: string }[] = [
    { id: 'all', label: t.usage.periodAll },
    { id: 'month', label: t.usage.periodMonth },
    { id: 'week', label: t.usage.periodWeek },
    { id: 'today', label: t.usage.periodToday },
  ];

  const data = useMemo(() => {
    const today = currentDate();
    return aggregate(records, getStartDate(period), today);
  }, [records, period]);

  const dateTokenMap = useMemo(() => buildDateTokenMap(records), [records]);

  const totalTokens = data.inputTokens + data.outputTokens;
  const cacheTotal = data.inputTokens + data.cacheReadTokens + data.cacheCreationTokens;
  const maxSkillTokens = data.bySkill[0]?.tokens ?? 0;
  const maxModelTokens = data.byModel[0]?.tokens ?? 0;

  return (
    <div className="px-6 py-5 space-y-5 overflow-y-auto h-full">
      {/* Period switcher */}
      <div className="flex gap-1">
        {periods.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => setPeriod(id)}
            className={`px-3 py-1 rounded-md text-[12px] font-medium transition-colors focus:outline-none focus-visible:outline-none focus-visible:ring-0 ${
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
        <KpiCard label={t.usage.requests} value={String(data.requests)} />
        <KpiCard
          label={t.usage.inputTokens}
          value={formatTokens(data.inputTokens)}
          sub={data.cacheReadTokens > 0 ? `cache ${formatTokens(data.cacheReadTokens)}` : undefined}
        />
        <KpiCard label={t.usage.outputTokens} value={formatTokens(data.outputTokens)} />
        <KpiCard
          label={t.usage.cacheHitRate}
          value={formatRate(data.cacheReadTokens, cacheTotal)}
          sub={totalTokens > 0 ? `${formatTokens(totalTokens)} total` : undefined}
        />
      </div>

      {/* Row 2 — Full-width 52-week heatmap */}
      <UsageHeatmap dateTokenMap={dateTokenMap} />

      {/* Row 3 — Full-width 30-day bar */}
      <UsageDailyBar dateTokenMap={dateTokenMap} />

      {/* Row 4 — By Model + By Skill (period-filtered) */}
      <div className="grid grid-cols-2 gap-6">
        <div className="space-y-2">
          <h3 className="text-[11px] font-medium text-[var(--abu-text-tertiary)] uppercase tracking-wider">{t.usage.byModel}</h3>
          {data.byModel.length === 0
            ? <p className="text-[12px] text-[var(--abu-text-muted)] py-1">—</p>
            : <div className="space-y-2">{data.byModel.slice(0, 10).map(item => <BarRow key={item.model} label={item.model} tokens={item.tokens} maxTokens={maxModelTokens} />)}</div>
          }
        </div>
        <div className="space-y-2">
          <h3 className="text-[11px] font-medium text-[var(--abu-text-tertiary)] uppercase tracking-wider">{t.usage.bySkill}</h3>
          {data.bySkill.length === 0
            ? <p className="text-[12px] text-[var(--abu-text-muted)] py-1">—</p>
            : <div className="space-y-2">{data.bySkill.slice(0, 10).map(item => <BarRow key={item.skill} label={item.skill} tokens={item.tokens} maxTokens={maxSkillTokens} />)}</div>
          }
        </div>
      </div>
    </div>
  );
}
