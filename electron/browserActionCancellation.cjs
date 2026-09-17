'use strict';

let nextOperation = 0;
// Cancellation is sent into the same isolated world as the wait. Keep the
// native promise alive until cleanup ACKs: a UI race alone is not a handback.
async function runCancellableAction({ action, payload, referenceBase, dispatch, signal }) {
  if (signal?.aborted) throw new Error('Browser action cancelled');
  if (!Number.isSafeInteger(++nextOperation)) throw new Error('Browser operation identities exhausted');
  const operationId = String(nextOperation);
  const runtime = 'globalThis.__ABU_ELECTRON_BROWSER_RUNTIME__';
  const guard = `${runtime}?.referenceBase === ${referenceBase}`;
  const cancel = () => {
    void Promise.resolve().then(() => dispatch(`if (${guard}) ${runtime}.cancelAction?.(${JSON.stringify(operationId)});`, false)).catch(() => {});
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    return await dispatch(`if (!(${guard})) throw new Error('Page changed. Observe again; do not replay.');
      ${runtime}.handleAction(${JSON.stringify(action)}, ${JSON.stringify({ ...payload, __abuOperationId: operationId })})`, true);
  } finally { signal?.removeEventListener('abort', cancel); }
}
module.exports = { runCancellableAction };
