import type { RendererRuntimeTraceSnapshot, RuntimeTraceEvent } from '@/core/observability/runtimeTrace';

export type RunTerminalOutcome = 'completed' | 'failed' | 'interrupted' | 'running' | 'unknown';
export type RunRootCause =
  | 'none'
  | 'context_budget'
  | 'sidecar_transport'
  | 'bridge_delivery'
  | 'start_ack'
  | 'user_stopped'
  | 'runtime_failure'
  | 'unknown';

export interface RunTimelineEvent {
  timestamp: number;
  process: 'renderer' | 'main' | 'sidecar';
  event: string;
  runId: string;
  clientMessageId?: string;
  stage?: string;
  outcome?: string;
  errorType?: string;
  durationMs?: number;
  replayCount?: number;
}

export interface RunTimelineSummary {
  runId: string;
  clientMessageId?: string;
  startedAt: number;
  finishedAt?: number;
  terminalOutcome: RunTerminalOutcome;
  rootCause: RunRootCause;
  replayCount: number;
  committed: boolean;
  events: RunTimelineEvent[];
}

export interface DiagnosticRunTimeline {
  schemaVersion: 1;
  takenAt: number;
  runCount: number;
  uncorrelatedEventCount: number;
  rootCauseCounts: Partial<Record<RunRootCause, number>>;
  runs: RunTimelineSummary[];
}

const VALID_PROCESS = new Set(['renderer', 'main', 'sidecar']);
const SAFE_STRING_KEYS = ['clientMessageId', 'stage', 'outcome', 'errorType'] as const;
const SAFE_NUMBER_KEYS = ['durationMs', 'replayCount'] as const;

function normalizeEvent(raw: unknown): RunTimelineEvent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (
    typeof value.timestamp !== 'number'
    || !Number.isFinite(value.timestamp)
    || typeof value.event !== 'string'
    || !/^[a-z][a-z0-9_.-]{0,79}$/.test(value.event)
    || typeof value.process !== 'string'
    || !VALID_PROCESS.has(value.process)
    || typeof value.runId !== 'string'
    || value.runId.length === 0
  ) return null;
  const event: RunTimelineEvent = {
    timestamp: Math.max(0, Math.round(value.timestamp)),
    process: value.process as RunTimelineEvent['process'],
    event: value.event,
    runId: value.runId.slice(0, 160),
  };
  for (const key of SAFE_STRING_KEYS) {
    if (typeof value[key] === 'string') event[key] = value[key].slice(0, 160);
  }
  for (const key of SAFE_NUMBER_KEYS) {
    if (typeof value[key] === 'number' && Number.isFinite(value[key])) {
      event[key] = Math.max(0, Math.round(value[key]));
    }
  }
  return event;
}

function parseMainEventLines(lines: string[]): { events: RunTimelineEvent[]; uncorrelated: number } {
  const events: RunTimelineEvent[] = [];
  let uncorrelated = 0;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as unknown;
      const normalized = normalizeEvent(parsed);
      if (normalized) events.push(normalized);
      else uncorrelated += 1;
    } catch {
      uncorrelated += 1;
    }
  }
  return { events, uncorrelated };
}

function classifyOutcome(events: RunTimelineEvent[]): RunTerminalOutcome {
  if (events.some((event) => event.event === 'renderer.agent_run_aborted')) return 'interrupted';
  if (events.some((event) => event.event === 'renderer.agent_run_failed' || event.event === 'sidecar.agent_run_failed')) return 'failed';
  if (events.some((event) => event.event === 'renderer.agent_run_completed')) return 'completed';
  const sidecarTerminal = [...events].reverse().find((event) => event.event === 'sidecar.agent_run_completed');
  if (sidecarTerminal?.outcome === 'aborted') return 'interrupted';
  if (sidecarTerminal?.outcome === 'error') return 'failed';
  if (sidecarTerminal?.outcome) return 'completed';
  if (events.some((event) => event.event === 'sidecar.agent_loop_started')) return 'running';
  return 'unknown';
}

function classifyRootCause(events: RunTimelineEvent[], outcome: RunTerminalOutcome): RunRootCause {
  if (outcome === 'interrupted') return 'user_stopped';
  if (events.some((event) => event.errorType?.includes('contextbudget'))) return 'context_budget';
  if (events.some((event) => (
    event.event === 'main.rpc_orphaned_on_sidecar_close'
    || event.event === 'main.sidecar_closed'
    || event.stage === 'failed_after_commit'
  ))) return 'sidecar_transport';
  if (events.some((event) => event.event === 'main.renderer_bridge_ack_timeout')) return 'bridge_delivery';
  if (events.some((event) => event.event === 'renderer.agent_start_ack_missing')) return 'start_ack';
  if (outcome === 'failed') return 'runtime_failure';
  if (outcome === 'completed') return 'none';
  return 'unknown';
}

export function buildDiagnosticRunTimeline(
  renderer: RendererRuntimeTraceSnapshot,
  mainEventLines: string[] = [],
  takenAt = Date.now(),
): DiagnosticRunTimeline {
  const parsedMain = parseMainEventLines(mainEventLines);
  const rendererEvents = renderer.recentEvents
    .map((event: RuntimeTraceEvent) => normalizeEvent(event))
    .filter((event): event is RunTimelineEvent => event !== null);
  const deduped = new Map<string, RunTimelineEvent>();
  for (const event of [...parsedMain.events, ...rendererEvents]) {
    const key = `${event.timestamp}:${event.process}:${event.event}:${event.runId}:${event.stage ?? ''}`;
    deduped.set(key, event);
  }
  const byRun = new Map<string, RunTimelineEvent[]>();
  for (const event of deduped.values()) {
    const runEvents = byRun.get(event.runId) ?? [];
    runEvents.push(event);
    byRun.set(event.runId, runEvents);
  }
  const runs = Array.from(byRun, ([runId, events]) => {
    events.sort((a, b) => a.timestamp - b.timestamp);
    const terminalOutcome = classifyOutcome(events);
    let finished: RunTimelineEvent | undefined;
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (
        event.event === 'renderer.agent_run_completed'
        || event.event === 'sidecar.agent_run_completed'
        || event.event === 'renderer.agent_run_failed'
        || event.event === 'renderer.agent_run_aborted'
      ) {
        finished = event;
        break;
      }
    }
    return {
      runId,
      clientMessageId: events.find((event) => event.clientMessageId)?.clientMessageId,
      startedAt: events[0].timestamp,
      ...(finished ? { finishedAt: finished.timestamp } : {}),
      terminalOutcome,
      rootCause: classifyRootCause(events, terminalOutcome),
      replayCount: Math.max(0, ...events.map((event) => event.replayCount ?? 0)),
      committed: events.some((event) => (
        event.event === 'renderer.first_frame_applied'
        || event.event === 'renderer.agent_delta_received'
        || event.event === 'sidecar.agent_delta_emitted'
      )),
      events,
    } satisfies RunTimelineSummary;
  }).sort((a, b) => b.startedAt - a.startedAt);
  const rootCauseCounts: Partial<Record<RunRootCause, number>> = {};
  for (const run of runs) rootCauseCounts[run.rootCause] = (rootCauseCounts[run.rootCause] ?? 0) + 1;
  return {
    schemaVersion: 1,
    takenAt,
    runCount: runs.length,
    uncorrelatedEventCount: parsedMain.uncorrelated,
    rootCauseCounts,
    runs,
  };
}
