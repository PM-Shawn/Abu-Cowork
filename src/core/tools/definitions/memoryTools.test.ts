import { describe, it, expect, vi, beforeEach } from 'vitest';
import { updateMemoryTool, reportPlanTool, buildPlanApprovalPayload, interpretPlanApproval, planHasRiskySteps } from './memoryTools';
import { useTaskExecutionStore } from '../../../stores/taskExecutionStore';
import { getI18n } from '../../../i18n';

// ──────────────────────────────────────────────────────────────────────────
// Mocks: lazy-imported in updateMemoryTool.execute, so vi.mock the real paths
// ──────────────────────────────────────────────────────────────────────────

const mockWriteMemory = vi.fn();
const mockDeleteMemory = vi.fn();
const mockClearAllMemories = vi.fn();
const mockScanMemoryFiles = vi.fn();
const mockReadMemoryFile = vi.fn();

vi.mock('../../memdir/write', () => ({
  writeMemory: (...args: unknown[]) => mockWriteMemory(...args),
  deleteMemory: (...args: unknown[]) => mockDeleteMemory(...args),
  clearAllMemories: (...args: unknown[]) => mockClearAllMemories(...args),
}));

vi.mock('../../memdir/scan', () => ({
  scanMemoryFiles: (...args: unknown[]) => mockScanMemoryFiles(...args),
  readMemoryFile: (...args: unknown[]) => mockReadMemoryFile(...args),
}));

vi.mock('../../safety/contentGuard', () => ({
  ContentSafetyError: class ContentSafetyError extends Error {
    scan: { findings: Array<{ severity: string; patternId: string; description: string; line: number; match: string }> };
    constructor(scan: ContentSafetyError['scan']) {
      super('blocked');
      this.scan = scan;
    }
  },
}));

vi.mock('../../../stores/workspaceStore', () => ({
  useWorkspaceStore: {
    getState: vi.fn().mockReturnValue({ currentPath: '/test/workspace' }),
    subscribe: vi.fn(),
  },
}));

const mockGetPlanMode = vi.fn();
const mockSetPlanMode = vi.fn();
const mockRequestUserQuestion = vi.fn();

vi.mock('../../agent/planMode', () => ({
  getPlanMode: (...a: unknown[]) => mockGetPlanMode(...a),
  setPlanMode: (...a: unknown[]) => mockSetPlanMode(...a),
}));

vi.mock('../../agent/permissionBridge', () => ({
  requestUserQuestion: (...a: unknown[]) => mockRequestUserQuestion(...a),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockGetPlanMode.mockReturnValue('off');
  mockWriteMemory.mockResolvedValue('newfile.md');
  mockDeleteMemory.mockResolvedValue(undefined);
  mockClearAllMemories.mockResolvedValue(0);
  mockScanMemoryFiles.mockResolvedValue([]);
  mockReadMemoryFile.mockResolvedValue(null);
});

describe('updateMemoryTool — append (default)', () => {
  it('writes a new memory when action omitted', async () => {
    const result = await updateMemoryTool.execute({
      name: 'preference',
      content: '用户偏好简洁回复',
      type: 'user',
    });

    expect(mockWriteMemory).toHaveBeenCalledOnce();
    const call = mockWriteMemory.mock.calls[0][0] as Record<string, unknown>;
    expect(call.name).toBe('preference');
    expect(call.content).toBe('用户偏好简洁回复');
    expect(call.type).toBe('user');
    expect(call.source).toBe('agent_explicit');
    expect(call).not.toHaveProperty('filename'); // append doesn't override
    expect(result).toContain('Memory saved');
  });

  it('rejects empty content in append mode', async () => {
    const result = await updateMemoryTool.execute({
      action: 'append',
      name: 'oops',
      content: '',
    });
    expect(result).toContain('content cannot be empty');
    expect(mockWriteMemory).not.toHaveBeenCalled();
  });
});

describe('updateMemoryTool — delete', () => {
  it('deletes the named memory', async () => {
    const result = await updateMemoryTool.execute({
      action: 'delete',
      filename: 'user_obsolete.md',
    });

    expect(mockDeleteMemory).toHaveBeenCalledWith('user_obsolete.md', '/test/workspace');
    expect(result).toContain('Memory deleted');
    expect(result).toContain('user_obsolete.md');
  });

  it('rejects delete without filename', async () => {
    const result = await updateMemoryTool.execute({ action: 'delete' });
    expect(result).toMatch(/Error:.*filename/);
    expect(mockDeleteMemory).not.toHaveBeenCalled();
  });
});

describe('updateMemoryTool — edit', () => {
  it('overwrites an existing memory and preserves source/scope', async () => {
    // Existing memory lives in workspace dir
    mockScanMemoryFiles
      .mockResolvedValueOnce([]) // global scan: empty
      .mockResolvedValueOnce([    // workspace scan: has the target
        {
          filename: 'user_name.md',
          filePath: '/test/workspace/.abu/memory/user_name.md',
          name: '用户名为小包',
          description: '用户名为小包',
          type: 'user',
          source: 'agent_explicit',
          created: 1000,
          updated: 2000,
          accessCount: 0,
        },
      ]);
    mockReadMemoryFile.mockResolvedValueOnce({
      header: {
        filename: 'user_name.md',
        filePath: '/test/workspace/.abu/memory/user_name.md',
        name: '用户名为小包',
        description: '用户名为小包',
        type: 'user',
        source: 'agent_explicit', // ← should be preserved
        created: 1000,
        updated: 2000,
        accessCount: 0,
      },
      content: '用户名为小包',
    });

    const result = await updateMemoryTool.execute({
      action: 'edit',
      filename: 'user_name.md',
      content: '用户名为小白',
    });

    expect(mockWriteMemory).toHaveBeenCalledOnce();
    const call = mockWriteMemory.mock.calls[0][0] as Record<string, unknown>;
    expect(call.filename).toBe('user_name.md'); // override flag set
    expect(call.content).toBe('用户名为小白');
    expect(call.name).toBe('用户名为小包');     // preserved when not overridden
    expect(call.type).toBe('user');             // preserved
    expect(call.source).toBe('agent_explicit'); // preserved
    expect(call.workspacePath).toBe('/test/workspace'); // workspace-scoped, not relocated
    expect(result).toContain('Memory updated');
  });

  it('returns directive error when filename does not exist', async () => {
    mockScanMemoryFiles.mockResolvedValue([]); // nothing exists

    const result = await updateMemoryTool.execute({
      action: 'edit',
      filename: 'user_ghost.md',
      content: 'whatever',
    });

    expect(result).toContain('user_ghost.md');
    expect(result).toContain('does not exist');
    expect(result).toContain('append'); // hint to switch action
    expect(mockWriteMemory).not.toHaveBeenCalled();
  });

  it('rejects edit without filename', async () => {
    const result = await updateMemoryTool.execute({
      action: 'edit',
      content: 'something',
    });
    expect(result).toMatch(/Error:.*filename/);
    expect(mockWriteMemory).not.toHaveBeenCalled();
  });

  it('rejects edit without content', async () => {
    mockScanMemoryFiles.mockResolvedValue([
      {
        filename: 'user_x.md', filePath: '/g/user_x.md', name: 'x', description: 'x',
        type: 'user', source: 'agent_explicit', created: 0, updated: 0, accessCount: 0,
      },
    ]);

    const result = await updateMemoryTool.execute({
      action: 'edit',
      filename: 'user_x.md',
    });
    expect(result).toMatch(/Error:.*content/);
    expect(mockWriteMemory).not.toHaveBeenCalled();
  });

  it('preserves global scope when memory lives in global dir', async () => {
    // Existing memory lives in global dir (not workspace)
    mockScanMemoryFiles
      .mockResolvedValueOnce([    // global scan
        {
          filename: 'user_name.md',
          filePath: '/Users/me/.abu/memory/user_name.md',
          name: 'old', description: 'old', type: 'user',
          source: 'auto_flush', created: 1000, updated: 2000, accessCount: 0,
        },
      ])
      .mockResolvedValueOnce([]); // workspace scan: empty
    mockReadMemoryFile.mockResolvedValueOnce({
      header: {
        filename: 'user_name.md', filePath: '/Users/me/.abu/memory/user_name.md',
        name: 'old', description: 'old', type: 'user',
        source: 'auto_flush', created: 1000, updated: 2000, accessCount: 0,
      },
      content: 'old',
    });

    await updateMemoryTool.execute({
      action: 'edit',
      filename: 'user_name.md',
      content: 'new',
    });

    const call = mockWriteMemory.mock.calls[0][0] as Record<string, unknown>;
    expect(call.workspacePath).toBeNull(); // global scope preserved, not relocated to workspace
    expect(call.source).toBe('auto_flush');  // preserved from existing
  });
});

describe('updateMemoryTool — clear', () => {
  it('clears all memories', async () => {
    mockClearAllMemories.mockResolvedValue(7);
    const result = await updateMemoryTool.execute({ action: 'clear' });
    expect(mockClearAllMemories).toHaveBeenCalledWith('/test/workspace');
    expect(result).toContain('Cleared');
    expect(result).toContain('7');
  });
});

describe('reportPlanTool — plan-mode approval (B1)', () => {
  describe('buildPlanApprovalPayload', () => {
    it('builds a single approve/reject question listing the steps', () => {
      const t = getI18n().toolResult.memory;
      const payload = buildPlanApprovalPayload(['扫描文件', '移动发票']);
      expect(payload.questions).toHaveLength(1);
      const q = payload.questions[0];
      expect(q.header).toBe(t.planApprovalHeader);
      expect(q.multiSelect).toBe(false);
      expect(q.options.map((o) => o.label)).toEqual([t.planApproveLabel, t.planRejectLabel]);
      expect(q.question).toContain('扫描文件');
      expect(q.question).toContain('移动发票');
      expect(q.question).toContain(t.planApprovalQuestion);
    });
  });

  describe('interpretPlanApproval', () => {
    it('returns false for null (timeout/cancel)', () => {
      expect(interpretPlanApproval(null)).toBe(false);
    });
    it('returns true when the approve option is selected', () => {
      const t = getI18n().toolResult.memory;
      expect(interpretPlanApproval({ answers: [{ header: t.planApprovalHeader, question: 'q', selected: [t.planApproveLabel] }] })).toBe(true);
    });
    it('returns false when the reject option is selected', () => {
      const t = getI18n().toolResult.memory;
      expect(interpretPlanApproval({ answers: [{ header: t.planApprovalHeader, question: 'q', selected: [t.planRejectLabel] }] })).toBe(false);
    });
    it('returns false for empty answers', () => {
      expect(interpretPlanApproval({ answers: [] })).toBe(false);
    });
    it('matches against the passed (build-time) label, not the current locale', () => {
      // Regression: the card echoes back the payload's own option label. If the
      // UI locale changes between building the card and reading the answer, a
      // freshly re-resolved label would mismatch. Passing the build-time label
      // (as reportPlanTool does from the payload) must still match.
      const buildTimeLabel = '批准执行'; // e.g. card was built while locale was zh-CN
      const result = { answers: [{ header: 'h', question: 'q', selected: [buildTimeLabel] }] };
      // Test env resolves to en-US, so the default (current-locale) label differs...
      expect(interpretPlanApproval(result)).toBe(false);
      // ...but passing the actual displayed label matches correctly.
      expect(interpretPlanApproval(result, buildTimeLabel)).toBe(true);
    });
  });

  describe('planHasRiskySteps', () => {
    it('flags destructive steps (zh)', () => {
      expect(planHasRiskySteps(['扫描桌面文件', '删除重复文件'])).toBe(true);
      expect(planHasRiskySteps(['移动发票到文件夹'])).toBe(true);
    });
    it('flags destructive/outbound steps (en, case-insensitive)', () => {
      expect(planHasRiskySteps(['Scan files', 'DELETE duplicates'])).toBe(true);
      expect(planHasRiskySteps(['upload report to server'])).toBe(true);
    });
    it('does not flag pure read-only plans', () => {
      expect(planHasRiskySteps(['查看文件列表', '分析数据', '总结结果'])).toBe(false);
      expect(planHasRiskySteps(['search the web', 'read the file'])).toBe(false);
    });
    it('returns false for empty/invalid input', () => {
      expect(planHasRiskySteps([])).toBe(false);
      expect(planHasRiskySteps(undefined as unknown as string[])).toBe(false);
    });
    it('does not flag noun compounds that merely contain a risky verb', () => {
      // Regression: "查看本地安装包" (inspect a local installer package) is
      // read-only but substring-matched 安装 and blocked a whole session.
      expect(planHasRiskySteps(['查看本地安装包里的目录结构'])).toBe(false);
      expect(planHasRiskySteps(['检查安装目录下有哪些文件'])).toBe(false);
      expect(planHasRiskySteps(['review the installation package layout'])).toBe(false);
    });
    it('still flags real install actions alongside noun mentions', () => {
      expect(planHasRiskySteps(['解压安装包并安装到系统'])).toBe(true);
      expect(planHasRiskySteps(['install nginx on the server'])).toBe(true);
    });
    it('noun exceptions must not swallow overlapping risky keywords (review regression)', () => {
      // Stripping exception substrings corrupted neighbors: "uninstaller"
      // lost its "installer" chunk and the remaining "un " no longer matched
      // the "uninstall" keyword — a destructive step slipped past the gate.
      expect(planHasRiskySteps(['run the uninstaller to wipe old data'])).toBe(true);
    });
    it('acting on an executable installer stays gated (executables are not exceptions)', () => {
      expect(planHasRiskySteps(['下载并运行安装程序'])).toBe(true);
      expect(planHasRiskySteps(['run the installer silently'])).toBe(true);
    });
  });

  describe('execute gating', () => {
    const ctx = { conversationId: 'c1', toolCallId: 't1', loopId: 'loop-1' };
    const input = { steps: [{ content: '步骤一' }, { content: '步骤二' }] };

    function seedExecution() {
      useTaskExecutionStore.setState({
        executions: {
          'exec-1': {
            id: 'exec-1', conversationId: 'c1', loopId: 'loop-1',
            status: 'running', startTime: 1, plannedSteps: [], planParsed: false, steps: [],
          } as unknown as import('@/types/execution').TaskExecution,
        },
        loopIdIndex: { 'loop-1': 'exec-1' },
      });
    }

    it('does not request approval for a safe plan when mode is off', async () => {
      mockGetPlanMode.mockReturnValue('off');
      const result = await reportPlanTool.execute(input, ctx);
      expect(mockRequestUserQuestion).not.toHaveBeenCalled();
      expect(mockSetPlanMode).not.toHaveBeenCalled();
      expect(result).toContain('Execution plan recorded');
    });

    it('auto-triggers approval for a RISKY plan even when mode is off', async () => {
      const t = getI18n().toolResult.memory;
      mockGetPlanMode.mockReturnValue('off');
      mockRequestUserQuestion.mockResolvedValue({ answers: [{ header: t.planApprovalHeader, question: 'q', selected: [t.planApproveLabel] }] });
      const result = await reportPlanTool.execute({ steps: [{ content: '扫描桌面文件' }, { content: '删除重复文件' }] }, ctx);
      expect(mockSetPlanMode).toHaveBeenCalledWith('c1', 'planning');
      expect(mockRequestUserQuestion).toHaveBeenCalledOnce();
      expect(mockSetPlanMode).toHaveBeenCalledWith('c1', 'approved');
      expect(result).toContain('approved');
    });

    it('approves: sets mode to approved and reports approval', async () => {
      const t = getI18n().toolResult.memory;
      mockGetPlanMode.mockReturnValue('planning');
      mockRequestUserQuestion.mockResolvedValue({ answers: [{ header: t.planApprovalHeader, question: 'q', selected: [t.planApproveLabel] }] });
      const result = await reportPlanTool.execute(input, ctx);
      expect(mockRequestUserQuestion).toHaveBeenCalledWith('t1', 'c1', expect.objectContaining({ questions: expect.any(Array) }));
      expect(mockSetPlanMode).toHaveBeenCalledWith('c1', 'approved');
      expect(result).toContain('approved');
    });

    it('rejects: stays in planning, does not approve', async () => {
      const t = getI18n().toolResult.memory;
      mockGetPlanMode.mockReturnValue('planning');
      mockRequestUserQuestion.mockResolvedValue({ answers: [{ header: t.planApprovalHeader, question: 'q', selected: [t.planRejectLabel] }] });
      const result = await reportPlanTool.execute(input, ctx);
      expect(mockSetPlanMode).not.toHaveBeenCalledWith('c1', 'approved');
      expect(result).toContain('not approve');
    });

    it('rejection tells the model to ASK the user before resubmitting (no silent re-prompt loop)', async () => {
      // Regression: the old text said "请根据反馈修改后重新调用 report_plan" —
      // but a rejection carries no feedback, so the model instantly re-submitted
      // an identical plan and the approval card re-popped with no words between.
      const t = getI18n().toolResult.memory;
      mockGetPlanMode.mockReturnValue('planning');
      mockRequestUserQuestion.mockResolvedValue({ answers: [{ header: t.planApprovalHeader, question: 'q', selected: [t.planRejectLabel] }] });
      const result = await reportPlanTool.execute(input, ctx);
      expect(result).toContain('ask');
      expect(result).toContain('do not');
    });

    it('approved plan lands plannedSteps on the loop execution (panel shows it)', async () => {
      const t = getI18n().toolResult.memory;
      seedExecution();
      mockGetPlanMode.mockReturnValue('planning');
      mockRequestUserQuestion.mockResolvedValue({ answers: [{ header: t.planApprovalHeader, question: 'q', selected: [t.planApproveLabel] }] });
      await reportPlanTool.execute(input, ctx);
      const exec = useTaskExecutionStore.getState().executions['exec-1'];
      expect(exec.plannedSteps.map((s) => s.description)).toEqual(['步骤一', '步骤二']);
    });

    it('rejected plan does NOT land plannedSteps (panel must not show a rejected plan)', async () => {
      const t = getI18n().toolResult.memory;
      seedExecution();
      mockGetPlanMode.mockReturnValue('planning');
      mockRequestUserQuestion.mockResolvedValue({ answers: [{ header: t.planApprovalHeader, question: 'q', selected: [t.planRejectLabel] }] });
      await reportPlanTool.execute(input, ctx);
      const exec = useTaskExecutionStore.getState().executions['exec-1'];
      expect(exec.plannedSteps).toHaveLength(0);
    });

    it('safe plan (no approval needed) lands plannedSteps immediately', async () => {
      seedExecution();
      mockGetPlanMode.mockReturnValue('off');
      await reportPlanTool.execute(input, ctx);
      const exec = useTaskExecutionStore.getState().executions['exec-1'];
      expect(exec.plannedSteps.map((s) => s.description)).toEqual(['步骤一', '步骤二']);
    });

    it('null result (timeout): stays read-only, does not approve', async () => {
      mockGetPlanMode.mockReturnValue('planning');
      mockRequestUserQuestion.mockResolvedValue(null);
      const result = await reportPlanTool.execute(input, ctx);
      expect(mockSetPlanMode).not.toHaveBeenCalledWith('c1', 'approved');
      expect(result).toContain('timed out');
    });

    it('skips approval when toolCallId is absent', async () => {
      mockGetPlanMode.mockReturnValue('planning');
      const result = await reportPlanTool.execute(input, { conversationId: 'c1' });
      expect(mockRequestUserQuestion).not.toHaveBeenCalled();
      expect(result).toContain('Execution plan recorded');
    });

    it('does NOT re-trigger approval for a risky plan once the conversation is already approved', async () => {
      // Regression: a plan with risky keywords re-triggered approval (and
      // re-locked writes via setPlanMode('planning')) on EVERY subsequent
      // report_plan status update, even after the user had already approved
      // this conversation's plan once.
      mockGetPlanMode.mockReturnValue('approved');
      const result = await reportPlanTool.execute({ steps: [{ content: '删除旧备份文件' }] }, ctx);
      expect(mockRequestUserQuestion).not.toHaveBeenCalled();
      expect(mockSetPlanMode).not.toHaveBeenCalledWith('c1', 'planning');
      expect(result).toContain('Execution plan recorded');
    });
  });
});

describe('reportPlanTool — declarative full-replace', () => {
  beforeEach(() => {
    useTaskExecutionStore.setState({ executions: {}, activeExecutionId: null, loopIdIndex: {} });
  });

  it('lands steps with declared statuses (content → description)', async () => {
    const store = useTaskExecutionStore.getState();
    const exec = store.createExecution('conv-1', 'loop-1');
    await reportPlanTool.execute(
      { steps: [
        { content: 'Scan files', status: 'completed' },
        { content: 'Build list', status: 'in_progress' },
        { content: 'Save output', status: 'pending' },
      ] },
      { conversationId: 'conv-1', loopId: 'loop-1', toolCallId: 'tc-1' } as never,
    );
    const landed = useTaskExecutionStore.getState().executions[exec.id].plannedSteps;
    expect(landed.map((s) => s.status)).toEqual(['completed', 'in_progress', 'pending']);
    expect(landed[0].description).toBe('Scan files');
  });

  it('full-replaces a plan that already has progress', async () => {
    const store = useTaskExecutionStore.getState();
    const exec = store.createExecution('conv-1', 'loop-1');
    store.setPlannedSteps(exec.id, [{ index: 1, description: 'old', status: 'in_progress' }]);
    await reportPlanTool.execute(
      { steps: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }, { content: 'c' }] },
      { conversationId: 'conv-1', loopId: 'loop-1', toolCallId: 'tc-1' } as never,
    );
    const landed = useTaskExecutionStore.getState().executions[exec.id].plannedSteps;
    expect(landed).toHaveLength(3);
    expect(landed[0].description).toBe('a');
  });

  it('defaults a missing status to pending', async () => {
    const store = useTaskExecutionStore.getState();
    const exec = store.createExecution('conv-1', 'loop-1');
    await reportPlanTool.execute(
      { steps: [{ content: 'one' }, { content: 'two' }, { content: 'three' }] },
      { conversationId: 'conv-1', loopId: 'loop-1', toolCallId: 'tc-1' } as never,
    );
    const landed = useTaskExecutionStore.getState().executions[exec.id].plannedSteps;
    expect(landed.every((s) => s.status === 'pending')).toBe(true);
  });
});

describe('reportPlanTool — write-side warnings', () => {
  beforeEach(() => {
    useTaskExecutionStore.setState({ executions: {}, activeExecutionId: null, loopIdIndex: {} });
  });
  const ctx = { conversationId: 'conv-1', loopId: 'loop-1', toolCallId: 'tc-1' } as never;

  it('warns on a small plan (<3 steps)', async () => {
    useTaskExecutionStore.getState().createExecution('conv-1', 'loop-1');
    const out = (await reportPlanTool.execute({ steps: [{ content: 'a' }, { content: 'b' }] }, ctx)) as string;
    expect(out).toContain('Small plan');
  });

  it('warns on a large plan (>10 steps)', async () => {
    useTaskExecutionStore.getState().createExecution('conv-1', 'loop-1');
    const steps = Array.from({ length: 11 }, (_, i) => ({ content: `s${i}` }));
    const out = (await reportPlanTool.execute({ steps }, ctx)) as string;
    expect(out).toContain('Large plan');
  });

  it('warns when more than 3 steps change at once', async () => {
    const exec = useTaskExecutionStore.getState().createExecution('conv-1', 'loop-1');
    useTaskExecutionStore.getState().setPlannedSteps(exec.id, [
      { index: 1, description: 'a', status: 'pending' },
      { index: 2, description: 'b', status: 'pending' },
      { index: 3, description: 'c', status: 'pending' },
      { index: 4, description: 'd', status: 'pending' },
    ]);
    const out = (await reportPlanTool.execute({ steps: [
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'completed' },
      { content: 'c', status: 'completed' },
      { content: 'd', status: 'completed' },
    ] }, ctx)) as string;
    expect(out).toContain('Updated many steps');
  });

  it('does NOT warn "Updated many steps" on the very first report_plan call (no prior plan)', async () => {
    // Regression: priorByIndex.get(i+1) is undefined for every step on the
    // first call, and undefined !== 'pending' was true — so every step counted
    // as "changed" and any 4+ step initial plan falsely tripped this warning.
    useTaskExecutionStore.getState().createExecution('conv-1', 'loop-1');
    const out = (await reportPlanTool.execute({ steps: [
      { content: 'a', status: 'pending' },
      { content: 'b', status: 'pending' },
      { content: 'c', status: 'pending' },
      { content: 'd', status: 'pending' },
    ] }, ctx)) as string;
    expect(out).not.toContain('Updated many steps');
  });
});
