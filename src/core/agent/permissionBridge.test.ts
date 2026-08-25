/**
 * Tests for the UserQuestion queue in permissionBridge.ts
 *
 * Covers only the new requestUserQuestion / resolveUserQuestion /
 * drainUserQuestions / drainUserQuestionsForConversation /
 * subscribeUserQuestion / getPendingUserQuestions APIs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  requestUserQuestion,
  resolveUserQuestion,
  drainUserQuestions,
  drainUserQuestionsForConversation,
  getPendingUserQuestions,
  subscribeUserQuestion,
  findQuestionOwningMessage,
  setLoopContext,
  clearLoopContext,
  getLoopContextForConversation,
  requestFilePermission,
  resolveFilePermission,
  getPendingFilePermission,
  drainFilePermissionQueue,
  type LoopContext,
} from './permissionBridge';
import { usePermissionStore } from '../../stores/permissionStore';
import type { Message, UserQuestionPayload, UserQuestionResult } from '../../types';
import {
  checkReadPath,
  checkWritePath,
  createAuthorizationScope,
  disposeAuthorizationScope,
  revokeWorkspace,
} from '../tools/pathSafety';

const MINIMAL_PAYLOAD: UserQuestionPayload = {
  questions: [
    {
      header: '格式',
      question: '你希望输出什么格式？',
      multiSelect: false,
      options: [{ label: '详细' }, { label: '简洁' }],
    },
  ],
};

const MINIMAL_RESULT: UserQuestionResult = {
  answers: [{ header: '格式', question: '你希望输出什么格式？', selected: ['详细'] }],
};

describe('permissionBridge — UserQuestion queue', () => {
  beforeEach(() => {
    drainUserQuestions();
  });

  afterEach(() => {
    drainUserQuestions();
  });

  describe('requestUserQuestion + resolveUserQuestion', () => {
    it('suspends a promise that resolveUserQuestion fulfills', async () => {
      const promise = requestUserQuestion('tc-1', 'conv-a', MINIMAL_PAYLOAD);
      expect(getPendingUserQuestions()).toHaveLength(1);
      expect(getPendingUserQuestions()[0].id).toBe('tc-1');

      resolveUserQuestion('tc-1', MINIMAL_RESULT);

      const result = await promise;
      expect(result).toEqual(MINIMAL_RESULT);
      expect(getPendingUserQuestions()).toHaveLength(0);
    });

    it('does not throw when resolving a nonexistent id', () => {
      expect(() => resolveUserQuestion('nonexistent', null)).not.toThrow();
    });

    it('resolves to null when resolved with null', async () => {
      const promise = requestUserQuestion('tc-2', 'conv-b', MINIMAL_PAYLOAD);
      resolveUserQuestion('tc-2', null);
      const result = await promise;
      expect(result).toBeNull();
    });
  });

  describe('drainUserQuestions', () => {
    it('resolves all pending to null and clears the queue', async () => {
      const p1 = requestUserQuestion('tc-3', 'conv-c', MINIMAL_PAYLOAD);
      const p2 = requestUserQuestion('tc-4', 'conv-c', MINIMAL_PAYLOAD);
      drainUserQuestions();
      expect(getPendingUserQuestions()).toHaveLength(0);
      expect(await p1).toBeNull();
      expect(await p2).toBeNull();
    });
  });

  describe('drainUserQuestionsForConversation', () => {
    it('only drains pending for the given conversationId', async () => {
      const pA = requestUserQuestion('tc-5', 'conv-target', MINIMAL_PAYLOAD);
      const pB = requestUserQuestion('tc-6', 'conv-other', MINIMAL_PAYLOAD);

      drainUserQuestionsForConversation('conv-target');

      expect(await pA).toBeNull();
      // pB should still be pending
      expect(getPendingUserQuestions()).toHaveLength(1);
      expect(getPendingUserQuestions()[0].id).toBe('tc-6');

      // cleanup
      resolveUserQuestion('tc-6', null);
      await pB;
    });
  });

  describe('subscribeUserQuestion', () => {
    it('fires on both enqueue and dequeue, stops after unsubscribe', () => {
      const listener = vi.fn();
      const unsub = subscribeUserQuestion(listener);

      requestUserQuestion('tc-7', 'conv-d', MINIMAL_PAYLOAD);
      expect(listener).toHaveBeenCalledTimes(1);

      resolveUserQuestion('tc-7', null);
      expect(listener).toHaveBeenCalledTimes(2);

      unsub();
      requestUserQuestion('tc-8', 'conv-d', MINIMAL_PAYLOAD);
      expect(listener).toHaveBeenCalledTimes(2);
      drainUserQuestions();
    });
  });

  describe('timeout', () => {
    it('auto-resolves to null after USER_QUESTION_TIMEOUT_MS', async () => {
      vi.useFakeTimers();
      const promise = requestUserQuestion('tc-timeout', 'conv-e', MINIMAL_PAYLOAD);
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 100);
      const result = await promise;
      expect(result).toBeNull();
      vi.useRealTimers();
    });
  });

  describe('getLoopContextForConversation', () => {
    const makeCtx = (loopId: string, conversationId: string): LoopContext => ({
      commandConfirmCallback: async () => true,
      filePermissionCallback: async () => true,
      signal: new AbortController().signal,
      eventRouter: {} as LoopContext['eventRouter'],
      loopId,
      conversationId,
      toolCallToStepId: new Map(),
    });

    it('resolves the loop owning the given conversation, not the first map entry', () => {
      // Regression (review): getCurrentLoopContext() returns the FIRST entry of
      // the global map — with two concurrent conversations, an enqueued user
      // message got tagged with the OTHER conversation's loopId.
      setLoopContext('loop-a', makeCtx('loop-a', 'conv-a'));
      setLoopContext('loop-b', makeCtx('loop-b', 'conv-b'));
      try {
        expect(getLoopContextForConversation('conv-b')?.loopId).toBe('loop-b');
        expect(getLoopContextForConversation('conv-a')?.loopId).toBe('loop-a');
        expect(getLoopContextForConversation('conv-none')).toBeNull();
      } finally {
        clearLoopContext('loop-a');
        clearLoopContext('loop-b');
      }
    });
  });

  describe('findQuestionOwningMessage', () => {
    const makeMsg = (id: string, toolCalls: Array<{ id: string; name: string }>): Message => ({
      id,
      role: 'assistant',
      content: '',
      timestamp: 0,
      toolCalls: toolCalls.map((tc) => ({ ...tc, input: {} })),
    });

    it('finds the message owning an ask_user_question tool call', () => {
      const msgs = [makeMsg('m1', [{ id: 'tc-a', name: 'ask_user_question' }])];
      expect(findQuestionOwningMessage(msgs, 'tc-a')?.id).toBe('m1');
    });

    it('finds the message owning a report_plan tool call (plan approval)', () => {
      // Regression: plan approval questions are keyed to a report_plan tool
      // call — the dock must locate them too, or the approval card never shows.
      const msgs = [
        makeMsg('m1', [{ id: 'tc-other', name: 'run_command' }]),
        makeMsg('m2', [{ id: 'tc-plan', name: 'report_plan' }]),
      ];
      expect(findQuestionOwningMessage(msgs, 'tc-plan')?.id).toBe('m2');
    });

    it('does not match a same-id tool call of an unrelated tool', () => {
      const msgs = [makeMsg('m1', [{ id: 'tc-x', name: 'run_command' }])];
      expect(findQuestionOwningMessage(msgs, 'tc-x')).toBeUndefined();
    });

    it('returns undefined when no message owns the id', () => {
      expect(findQuestionOwningMessage([], 'tc-none')).toBeUndefined();
    });
  });
});

describe('permissionBridge — resolveFilePermission pending guard (F1 regression)', () => {
  beforeEach(() => {
    drainFilePermissionQueue();
    usePermissionStore.setState({ persistedGrants: {}, sessionGrants: {}, pendingRequest: null });
  });

  afterEach(() => {
    drainFilePermissionQueue();
    usePermissionStore.setState({ persistedGrants: {}, sessionGrants: {}, pendingRequest: null });
  });

  it('does not persist a grant when there is no pending file-permission request', () => {
    // Pre-E-block behavior: grantPermission lived entirely inside
    // `if (pendingFilePermission) { ... }` — calling resolveFilePermission
    // with nothing pending was a total no-op. A refactor regression made the
    // grant side effect run unconditionally, ahead of the pending check.
    expect(getPendingFilePermission()).toBeNull();

    resolveFilePermission(true, '/ws/no-pending', ['write'], 'always');

    expect(usePermissionStore.getState().hasPermission('/ws/no-pending', 'write')).toBe(false);
    expect(Object.keys(usePermissionStore.getState().persistedGrants)).toHaveLength(0);
  });

  it('persists a grant and resolves the promise when a request is genuinely pending', async () => {
    const promise = requestFilePermission({ path: '/ws/real', capability: 'write', toolName: 'write_file' });
    expect(getPendingFilePermission()).not.toBeNull();

    resolveFilePermission(true, '/ws/real', ['write'], 'always');

    await expect(promise).resolves.toBe(true);
    expect(usePermissionStore.getState().hasPermission('/ws/real', 'write')).toBe(true);
  });

  it('double resolve (e.g. duplicate dialog submit) — the second call is a no-op', async () => {
    const promise = requestFilePermission({ path: '/ws/double', capability: 'write', toolName: 'write_file' });

    // First resolve: a request really is pending — grants and settles it.
    resolveFilePermission(true, '/ws/double', ['write'], 'always');
    await expect(promise).resolves.toBe(true);
    expect(usePermissionStore.getState().hasPermission('/ws/double', 'write')).toBe(true);

    // Revoke so a re-grant on the second call would be observable.
    usePermissionStore.getState().revokePermission('/ws/double');
    expect(usePermissionStore.getState().hasPermission('/ws/double', 'write')).toBe(false);

    // Second resolve: nothing pending anymore — must not re-grant.
    resolveFilePermission(true, '/ws/double', ['write'], 'always');
    expect(usePermissionStore.getState().hasPermission('/ws/double', 'write')).toBe(false);
  });

  it('syncs an existing permission into the loopId-owned scope, not the first ambient loop context', async () => {
    const path = '/Users/testuser/Projects/permission-bridge-owned/out.md';
    const scopeA = createAuthorizationScope();
    const scopeB = createAuthorizationScope();
    setLoopContext('loop-a', {
      loopId: 'loop-a',
      conversationId: 'conv-a',
      toolCallToStepId: new Map(),
      authorizationScopeId: scopeA,
    } as unknown as LoopContext);
    setLoopContext('loop-b', {
      loopId: 'loop-b',
      conversationId: 'conv-b',
      toolCallToStepId: new Map(),
      authorizationScopeId: scopeB,
    } as unknown as LoopContext);
    usePermissionStore.getState().grantPermission(path, ['write'], 'session');

    try {
      await expect(requestFilePermission({ path, capability: 'write', toolName: 'write_file' }, 'loop-b')).resolves.toBe(true);

      expect((await checkWritePath(path, scopeB)).allowed).toBe(true);
      expect((await checkWritePath(path, scopeA)).allowed).toBe(false);
    } finally {
      clearLoopContext('loop-a');
      clearLoopContext('loop-b');
      disposeAuthorizationScope(scopeA);
      disposeAuthorizationScope(scopeB);
    }
  });

  it('syncs an existing read permission into the run scope without granting write', async () => {
    const path = '/Users/testuser/Projects/permission-bridge-read/notes.md';
    const scopeId = createAuthorizationScope();
    setLoopContext('loop-read-only', {
      loopId: 'loop-read-only',
      conversationId: 'conv-read-only',
      toolCallToStepId: new Map(),
      authorizationScopeId: scopeId,
    } as unknown as LoopContext);
    usePermissionStore.getState().grantPermission(path, ['read'], 'session');

    try {
      await expect(requestFilePermission({ path, capability: 'read', toolName: 'read_file' }, 'loop-read-only')).resolves.toBe(true);

      expect((await checkReadPath(path, scopeId)).allowed).toBe(true);
      expect((await checkWritePath(path, scopeId)).allowed).toBe(false);
    } finally {
      clearLoopContext('loop-read-only');
      disposeAuthorizationScope(scopeId);
    }
  });

  it('syncs a global read grant without widening it to write', async () => {
    const path = '/Users/testuser/Projects/permission-bridge-global-read/notes.md';

    try {
      usePermissionStore.getState().grantPermission(path, ['read'], 'session');
      expect((await checkReadPath(path)).allowed).toBe(true);
      expect((await checkWritePath(path)).allowed).toBe(false);

      // Simulate pathSafety state being rebuilt independently: the bridge's
      // fast path must preserve the requested capability when it re-syncs.
      revokeWorkspace(path);
      await expect(requestFilePermission({
        path,
        capability: 'read',
        toolName: 'read_file',
      })).resolves.toBe(true);
      expect((await checkReadPath(path)).allowed).toBe(true);
      expect((await checkWritePath(path)).allowed).toBe(false);
    } finally {
      usePermissionStore.getState().revokePermission(path);
      revokeWorkspace(path);
    }
  });

  it('treats an empty authorization scope as explicit and never syncs existing grants globally', async () => {
    const path = '/Users/testuser/Projects/permission-bridge-empty/notes.md';
    setLoopContext('loop-empty-scope', {
      loopId: 'loop-empty-scope',
      conversationId: 'conv-empty-scope',
      toolCallToStepId: new Map(),
      authorizationScopeId: '',
    } as unknown as LoopContext);
    usePermissionStore.setState({
      sessionGrants: {
        [path]: {
          path,
          grantedAt: 0,
          expiresAt: null,
          capabilities: ['read'],
          duration: 'session',
        },
      },
      persistedGrants: {},
      pendingRequest: null,
    });

    try {
      await expect(requestFilePermission({ path, capability: 'read', toolName: 'read_file' }, 'loop-empty-scope')).resolves.toBe(true);

      expect((await checkReadPath(path, '')).allowed).toBe(false);
      expect((await checkWritePath(path)).allowed).toBe(false);
    } finally {
      clearLoopContext('loop-empty-scope');
      usePermissionStore.setState({ persistedGrants: {}, sessionGrants: {}, pendingRequest: null });
    }
  });
});
