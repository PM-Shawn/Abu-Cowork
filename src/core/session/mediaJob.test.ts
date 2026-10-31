import { describe, expect, it } from 'vitest';
import type { MediaJob } from '@/types/media';
import { acceptMediaJobUpdate, detachMediaJob, recoverMediaJob, transitionMediaJob } from '@/core/session/mediaJob';

const prepared: MediaJob = {
  schemaVersion: 1, id: 'job-1', requestId: 'request-1', scope: 'local', conversationId: 'conversation-1',
  attempt: 1, generationState: 'prepared', waitState: 'waiting', sequence: 0, outputArtifactIds: [],
};

describe('media job lifecycle', () => {
  it('completes only after saving a result', () => {
    const submitting = transitionMediaJob(prepared, 'submitting');
    const running = transitionMediaJob(submitting, 'running');
    const saving = transitionMediaJob(running, 'saving');
    expect(() => transitionMediaJob(saving, 'completed')).toThrow('saved artifact');
    const completed = transitionMediaJob(saving, 'completed', { outputArtifactIds: ['image-2'] });
    expect(completed.sequence).toBe(4);
    expect(() => transitionMediaJob(completed, 'submitting')).toThrow('Invalid media');
  });

  it('retains a pending request when the user stops waiting', () => {
    const running = { ...prepared, generationState: 'running' as const };
    const detached = detachMediaJob(running);
    expect(detached.generationState).toBe('running');
    expect(detachMediaJob(detached)).toBe(detached);
    expect(transitionMediaJob(detached, 'saving').waitState).toBe('detached');
  });

  it('recovers ambiguous network work without resubmitting it', () => {
    for (const generationState of ['submitting', 'running'] as const) {
      const recovered = recoverMediaJob({ ...prepared, generationState });
      expect(recovered.generationState).toBe('unknown');
      expect(() => transitionMediaJob(recovered, 'submitting')).toThrow();
    }
    expect(recoverMediaJob(prepared)).toBe(prepared);
  });

  it('retries saving without returning to generation', () => {
    const recovered = recoverMediaJob({ ...prepared, generationState: 'saving' });
    expect(recovered.generationState).toBe('save_failed');
    expect(transitionMediaJob(recovered, 'saving').generationState).toBe('saving');
    expect(() => transitionMediaJob(recovered, 'submitting')).toThrow();
  });

  it('ignores duplicate and older events and rejects another owner', () => {
    const running = transitionMediaJob(transitionMediaJob(prepared, 'submitting'), 'running');
    expect(acceptMediaJobUpdate(running, prepared)).toBe(running);
    expect(acceptMediaJobUpdate(running, { ...running })).toBe(running);
    expect(acceptMediaJobUpdate(prepared, running)).toEqual(running);
    expect(acceptMediaJobUpdate(undefined, running)).toEqual(running);
    expect(() => acceptMediaJobUpdate(running, { ...running, scope: 'another-account' })).toThrow('another request');
  });
});
