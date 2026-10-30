import { mediaJobSchema, type MediaGenerationState, type MediaJob } from '@/types/media';

const transitions: Record<MediaGenerationState, readonly MediaGenerationState[]> = {
  prepared: ['submitting', 'failed'],
  submitting: ['running', 'unknown', 'failed'],
  running: ['saving', 'unknown', 'failed', 'cancelled'],
  saving: ['completed', 'save_failed'],
  save_failed: ['saving'],
  unknown: ['saving', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

export function transitionMediaJob(
  job: MediaJob,
  generationState: MediaGenerationState,
  details: { outputArtifactIds?: string[]; error?: string } = {},
): MediaJob {
  if (!transitions[job.generationState].includes(generationState)) {
    throw new Error(`Invalid media job transition: ${job.generationState} to ${generationState}`);
  }
  const next = mediaJobSchema.parse({
    ...job, generationState, sequence: job.sequence + 1,
    outputArtifactIds: details.outputArtifactIds ?? job.outputArtifactIds,
    error: details.error,
  });
  if (generationState === 'completed' && next.outputArtifactIds.length === 0) {
    throw new Error('A completed media job must have a saved artifact');
  }
  return next;
}

/** Stopping a wait does not claim that the provider cancelled generation. */
export function detachMediaJob(job: MediaJob): MediaJob {
  return job.waitState === 'detached' ? job : { ...job, waitState: 'detached', sequence: job.sequence + 1 };
}

/** A host restart never repeats an ambiguous paid request. */
export function recoverMediaJob(job: MediaJob): MediaJob {
  if (job.generationState === 'submitting' || job.generationState === 'running') {
    return transitionMediaJob(job, 'unknown');
  }
  if (job.generationState === 'saving') return transitionMediaJob(job, 'save_failed');
  return job;
}

export function acceptMediaJobUpdate(current: MediaJob | undefined, incoming: MediaJob): MediaJob {
  const parsed = mediaJobSchema.parse(incoming);
  if (!current) return parsed;
  if (current.id !== parsed.id || current.requestId !== parsed.requestId
    || current.scope !== parsed.scope || current.conversationId !== parsed.conversationId) {
    throw new Error('Media job update belongs to another request');
  }
  return parsed.sequence > current.sequence ? parsed : current;
}
