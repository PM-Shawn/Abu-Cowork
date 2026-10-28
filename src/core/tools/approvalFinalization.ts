import type { ToolApprovalDecision } from './registry';
import type { OperationAuthorizationDecision, ToolOperationAuthorization } from './operationAuthorization';
import type { ToolFileAccess } from '@/core/tools/fileOperation';
import type { BrowserScreenshotSave } from '@/core/tools/browserScreenshotSave';
import type { ObservedFileTarget } from '@/core/tools/fileOperationHost';

interface ApprovalOperation {
  authorization?: ToolOperationAuthorization;
  input: Readonly<Record<string, unknown>>;
  recordDenial: (decision: Exclude<OperationAuthorizationDecision, { decision: 'allow' }>) => void;
  reportConsent: () => void;
  checkPermissions?: () => ToolApprovalDecision | null | Promise<ToolApprovalDecision | null>;
  files?: ToolFileAccess;
  screenshot?: BrowserScreenshotSave;
  authorizeScreenshot?: (target: ObservedFileTarget) => Promise<void>;
  release?: () => void;
  getScopeId?: () => string | undefined;
}

const operations = new WeakMap<ToolApprovalDecision, ApprovalOperation>();

export function rememberToolApproval(decision: ToolApprovalDecision, operation: ApprovalOperation): void {
  operations.set(decision, operation);
}

export function filesForToolApproval(decision: ToolApprovalDecision): ToolFileAccess | undefined {
  return operations.get(decision)?.files;
}

export function screenshotForToolApproval(decision: ToolApprovalDecision) {
  const operation = operations.get(decision);
  return operation?.screenshot && operation.authorizeScreenshot
    ? { save: operation.screenshot, authorize: operation.authorizeScreenshot } : undefined;
}

export function scopeForToolApproval(decision: ToolApprovalDecision): string | undefined {
  return operations.get(decision)?.getScopeId?.();
}

export async function releaseToolApproval(decision: ToolApprovalDecision): Promise<void> {
  const operation = operations.get(decision);
  if (!operation) return;
  operations.delete(decision);
  try {
    await operation.files?.dispose();
  } finally {
    try { await operation.screenshot?.dispose(); }
    finally { operation.release?.(); }
  }
}

/** A synchronous allow has passed every check immediately before consumption. */
export function finalizeToolApproval(decision: ToolApprovalDecision): ToolApprovalDecision | Promise<ToolApprovalDecision> {
  const operation = operations.get(decision);
  if (!operation || decision.decision === 'deny') return decision;
  const checked = operation.authorization?.validate(operation.input) ?? { decision: 'allow' };
  if (checked.decision === 'reauthorize') {
    return operation.authorization!.authorize(operation.input).then(result => {
      if (result.decision === 'allow') return decision;
      operation.recordDenial(result);
      return { decision: 'deny', reason: result.reason };
    });
  }
  if (checked.decision === 'deny') {
    operation.recordDenial(checked);
    return { decision: 'deny', reason: checked.reason };
  }
  const permissions = operation.checkPermissions?.();
  if (permissions instanceof Promise) return permissions.then(result => result ?? decision);
  if (permissions) return permissions;
  operation.reportConsent();
  return decision;
}
