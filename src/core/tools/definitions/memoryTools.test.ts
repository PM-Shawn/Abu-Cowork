import { describe, it, expect, vi, beforeEach } from 'vitest';
import { updateMemoryTool, reportPlanTool, buildPlanApprovalPayload, interpretPlanApproval, PLAN_APPROVE_LABEL, PLAN_REJECT_LABEL } from './memoryTools';

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
    expect(result).toContain('已保存记忆');
  });

  it('rejects empty content in append mode', async () => {
    const result = await updateMemoryTool.execute({
      action: 'append',
      name: 'oops',
      content: '',
    });
    expect(result).toContain('content 不能为空');
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
    expect(result).toContain('已删除记忆');
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
    expect(result).toContain('已更新记忆');
  });

  it('returns directive error when filename does not exist', async () => {
    mockScanMemoryFiles.mockResolvedValue([]); // nothing exists

    const result = await updateMemoryTool.execute({
      action: 'edit',
      filename: 'user_ghost.md',
      content: 'whatever',
    });

    expect(result).toContain('user_ghost.md');
    expect(result).toContain('不存在');
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
    expect(result).toContain('已清空');
    expect(result).toContain('7');
  });
});

describe('reportPlanTool — plan-mode approval (B1)', () => {
  describe('buildPlanApprovalPayload', () => {
    it('builds a single approve/reject question listing the steps', () => {
      const payload = buildPlanApprovalPayload(['扫描文件', '移动发票']);
      expect(payload.questions).toHaveLength(1);
      const q = payload.questions[0];
      expect(q.header).toBe('计划审批');
      expect(q.multiSelect).toBe(false);
      expect(q.options.map((o) => o.label)).toEqual([PLAN_APPROVE_LABEL, PLAN_REJECT_LABEL]);
      expect(q.question).toContain('扫描文件');
      expect(q.question).toContain('移动发票');
      expect(q.question).toContain('是否批准');
    });
  });

  describe('interpretPlanApproval', () => {
    it('returns false for null (timeout/cancel)', () => {
      expect(interpretPlanApproval(null)).toBe(false);
    });
    it('returns true when the approve option is selected', () => {
      expect(interpretPlanApproval({ answers: [{ header: '计划审批', question: 'q', selected: [PLAN_APPROVE_LABEL] }] })).toBe(true);
    });
    it('returns false when the reject option is selected', () => {
      expect(interpretPlanApproval({ answers: [{ header: '计划审批', question: 'q', selected: [PLAN_REJECT_LABEL] }] })).toBe(false);
    });
    it('returns false for empty answers', () => {
      expect(interpretPlanApproval({ answers: [] })).toBe(false);
    });
  });

  describe('execute gating', () => {
    const ctx = { conversationId: 'c1', toolCallId: 't1' };
    const input = { steps: ['步骤一', '步骤二'] };

    it('does not request approval when plan mode is off', async () => {
      mockGetPlanMode.mockReturnValue('off');
      const result = await reportPlanTool.execute(input, ctx);
      expect(mockRequestUserQuestion).not.toHaveBeenCalled();
      expect(mockSetPlanMode).not.toHaveBeenCalled();
      expect(result).toContain('已记录执行计划');
    });

    it('approves: sets mode to approved and reports approval', async () => {
      mockGetPlanMode.mockReturnValue('planning');
      mockRequestUserQuestion.mockResolvedValue({ answers: [{ header: '计划审批', question: 'q', selected: [PLAN_APPROVE_LABEL] }] });
      const result = await reportPlanTool.execute(input, ctx);
      expect(mockRequestUserQuestion).toHaveBeenCalledWith('t1', 'c1', expect.objectContaining({ questions: expect.any(Array) }));
      expect(mockSetPlanMode).toHaveBeenCalledWith('c1', 'approved');
      expect(result).toContain('已批准');
    });

    it('rejects: stays in planning, does not approve', async () => {
      mockGetPlanMode.mockReturnValue('planning');
      mockRequestUserQuestion.mockResolvedValue({ answers: [{ header: '计划审批', question: 'q', selected: [PLAN_REJECT_LABEL] }] });
      const result = await reportPlanTool.execute(input, ctx);
      expect(mockSetPlanMode).not.toHaveBeenCalled();
      expect(result).toContain('未批准');
    });

    it('null result (timeout): stays read-only, does not approve', async () => {
      mockGetPlanMode.mockReturnValue('planning');
      mockRequestUserQuestion.mockResolvedValue(null);
      const result = await reportPlanTool.execute(input, ctx);
      expect(mockSetPlanMode).not.toHaveBeenCalled();
      expect(result).toContain('超时');
    });

    it('skips approval when toolCallId is absent', async () => {
      mockGetPlanMode.mockReturnValue('planning');
      const result = await reportPlanTool.execute(input, { conversationId: 'c1' });
      expect(mockRequestUserQuestion).not.toHaveBeenCalled();
      expect(result).toContain('已记录执行计划');
    });
  });
});
