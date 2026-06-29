/**
 * Scheduler output-delivery tests (review finding [2]).
 *
 * Mirrors the trigger delivery tests: a scheduled run that hit the turn cap
 * (max_turns) still produced a usable partial answer, so its output must still be
 * pushed to the configured IM channel (flagged incomplete). no_progress / aborted
 * have no usable output and must NOT be delivered.
 *
 * runAgentLoop is mocked so we control the exit reason; outputSender is mocked so
 * `buildMessage` being called is the observable "delivery happened" signal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useScheduleStore } from '../../stores/scheduleStore';
import { useChatStore } from '../../stores/chatStore';
import type { ScheduledTask } from '../../types/schedule';

// Mock agentLoop — control the exit reason. isIncompleteReason is a trivial pure
// fn (tested in agentLoop.test.ts); duplicate it here to avoid importing the real
// heavy module and its dependency tree.
vi.mock('../agent/agentLoop', () => ({
  runAgentLoop: vi.fn(),
  isIncompleteReason: (r: string) => r === 'max_turns' || r === 'no_progress',
}));

// Mock outputSender — buildMessage being called means delivery was entered.
vi.mock('../im/outputSender', () => ({
  outputSender: {
    buildMessage: vi.fn().mockReturnValue('test message'),
    send: vi.fn().mockResolvedValue({ success: true }),
  },
}));

// Mock notifications (avoid Tauri)
vi.mock('../../utils/notifications', () => ({
  notifyScheduledTaskCompleted: vi.fn(),
  notifyScheduledTaskError: vi.fn(),
}));

// Import after mocks
import { schedulerEngine } from './scheduler';
import { runAgentLoop } from '../agent/agentLoop';
import { outputSender } from '../im/outputSender';

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'task-1',
    name: 'Test Task',
    prompt: 'do something',
    schedule: { frequency: 'daily', time: { hour: 9, minute: 0 } },
    status: 'active',
    // Output configured so the delivery path (pushToIMChannel → buildMessage) is reachable
    outputChannelId: 'channel-1',
    outputChatIds: 'chat-1',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    runs: [],
    totalRuns: 0,
    ...overrides,
  };
}

function latestRunStatus(taskId: string): string | undefined {
  const runs = useScheduleStore.getState().tasks[taskId]?.runs ?? [];
  return runs[runs.length - 1]?.status;
}

describe('SchedulerEngine output delivery by exit reason', () => {
  beforeEach(() => {
    useScheduleStore.setState({ tasks: {} });
    useChatStore.setState({
      conversations: {},
      activeConversationId: null,
      agentStatus: 'idle',
      currentTool: null,
      currentUsage: null,
      pendingInput: null,
      thinkingStartTime: null,
    });
    vi.clearAllMocks();
  });

  it('delivers output when the run hit the turn cap (max_turns)', async () => {
    const task = makeTask({ id: 'task-maxturns' });
    useScheduleStore.setState({ tasks: { [task.id]: task } });
    vi.mocked(runAgentLoop).mockResolvedValue({ reason: 'max_turns' });

    await schedulerEngine.runNow(task.id);

    expect(outputSender.buildMessage).toHaveBeenCalled();
    expect(latestRunStatus(task.id)).toBe('completed');
  });

  it('does NOT deliver output on no_progress (degenerate result)', async () => {
    const task = makeTask({ id: 'task-noprogress' });
    useScheduleStore.setState({ tasks: { [task.id]: task } });
    vi.mocked(runAgentLoop).mockResolvedValue({ reason: 'no_progress' });

    await schedulerEngine.runNow(task.id);

    expect(outputSender.buildMessage).not.toHaveBeenCalled();
    expect(latestRunStatus(task.id)).toBe('error');
  });

  it('does NOT deliver output on aborted', async () => {
    const task = makeTask({ id: 'task-aborted' });
    useScheduleStore.setState({ tasks: { [task.id]: task } });
    vi.mocked(runAgentLoop).mockResolvedValue({ reason: 'aborted' });

    await schedulerEngine.runNow(task.id);

    expect(outputSender.buildMessage).not.toHaveBeenCalled();
    expect(latestRunStatus(task.id)).toBe('error');
  });
});
