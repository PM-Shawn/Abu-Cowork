import type { ToolExecutionContext } from '../../types';
import type {
  CommandConfirmCallback,
  FilePermissionCallback,
} from '../tools/registry';
import { checkToolApproval } from '../tools/registry';
import type { SkillCommandApprovalCallback } from '../skill/preprocessor';

const denyCommandConfirmation: CommandConfirmCallback = async () => false;
const denyFilePermission: FilePermissionCallback = async () => false;

/**
 * Attach the shell-owned approval chain used by executable skill directives.
 * The callback deliberately ignores every authority-bearing value supplied in
 * its request and closes over this trusted context instead.
 */
export function attachTrustedSkillCommandApproval(
  context: ToolExecutionContext,
  callbacks: {
    commandConfirmCallback?: CommandConfirmCallback;
    filePermissionCallback?: FilePermissionCallback;
  } = {},
): ToolExecutionContext {
  const trustedContext: ToolExecutionContext = { ...context };
  const skillCommandApproval: SkillCommandApprovalCallback = async (request) =>
    checkToolApproval(
      request.toolName,
      request.input,
      trustedContext,
      callbacks.commandConfirmCallback ?? denyCommandConfirmation,
      callbacks.filePermissionCallback ?? denyFilePermission,
    );

  trustedContext.skillCommandApproval = skillCommandApproval;
  return trustedContext;
}
