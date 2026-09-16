/**
 * A dispatch rejection that can still state who owns the submitted message.
 *
 * The runner keeps rejecting persistence/transport exceptions for non-UI
 * callers, while the renderer can distinguish an exception raised after the
 * user message entered the transcript from one raised before ownership.
 */
export class AgentLoopDispatchError extends Error {
  readonly messageTaken: boolean;

  constructor(error: unknown, messageTaken: boolean) {
    super(error instanceof Error ? error.message : String(error), { cause: error });
    this.name = 'AgentLoopDispatchError';
    this.messageTaken = messageTaken;
  }
}

export function wrapAgentLoopDispatchError(
  error: unknown,
  messageTaken: boolean,
): AgentLoopDispatchError {
  if (error instanceof AgentLoopDispatchError && error.messageTaken === messageTaken) {
    return error;
  }
  return new AgentLoopDispatchError(error, messageTaken);
}
