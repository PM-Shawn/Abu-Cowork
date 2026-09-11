import type { ToolDefinition } from '../../../types';
import { TOOL_NAMES } from '../toolNames';
import { getI18n, format } from '../../../i18n';
import { exists, stat } from '../fsBridge';
import { sendIMFile } from '../../im/streamingReply';
import { WECHAT_MAX_OUTBOUND_BYTES } from '../../im/adapters/wechat';
import { getBaseName } from '../../../utils/pathUtils';
import { formatFileSize } from '@/utils/formatFileSize';
import type { IMPlatform } from '../../../types/im';

/**
 * send_file — deliver a local file (image / document) to the current IM user.
 *
 * IM-only: it reads `context.imReplyTarget`, set by agentLoop solely for runs
 * dispatched from an IM channel. Outside IM (interactive desktop / scheduled /
 * trigger) the target is absent and the tool refuses — there is no external
 * recipient to send to.
 *
 * Capability gating happens at the roster level, not here: `send_file` is
 * deliberately absent from `READ_ONLY_TOOL_ALLOWLIST`, so a `read_tools` channel
 * (fail-closed allowlist) can never call it — that keeps an unattended read-only
 * channel from exfiltrating workspace files. `chat_only` disables tools outright.
 * `safe_tools` / `full` may use it.
 */
export const sendFileTool: ToolDefinition = {
  name: TOOL_NAMES.SEND_FILE,
  description:
    'Send a local file (image or document) to the current user in this IM channel. ' +
    'Only works inside an IM conversation. Provide an ABSOLUTE path (e.g. /tmp/report.pdf); ' +
    'relative paths cannot be resolved. Known image types (jpg/png/gif/webp) are delivered as ' +
    'an image; everything else as a file attachment. Use this to deliver generated files, ' +
    'charts, or documents — not for files the user already has.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path to the local file to send' },
      caption: { type: 'string', description: 'Optional text caption sent alongside the file' },
    },
    required: ['path'],
  },
  execute: async (input, context) => {
    const t = getI18n().toolResult.im;

    const target = context?.imReplyTarget;
    if (!target) {
      return t.sendFileNotInIM;
    }

    const filePath = typeof input.path === 'string' ? input.path.trim() : '';
    if (!filePath) {
      return t.sendFileNeedsPath;
    }
    const caption = typeof input.caption === 'string' ? input.caption : undefined;

    try {
      if (!(await exists(filePath))) {
        return format(t.sendFileNotFound, { path: filePath });
      }
      const info = await stat(filePath);
      if (!info.isFile) {
        return format(t.sendFileNotAFile, { path: filePath });
      }
      if (info.size > WECHAT_MAX_OUTBOUND_BYTES) {
        return format(t.sendFileTooLarge, {
          size: formatFileSize(info.size),
          max: formatFileSize(WECHAT_MAX_OUTBOUND_BYTES),
        });
      }

      const result = await sendIMFile(target.platform as IMPlatform, target.chatId, {
        filePath,
        caption,
      });

      if (result.sent) {
        const fileName = getBaseName(filePath) || filePath;
        return format(t.sendFileSuccess, { fileName });
      }
      if (result.error === 'media_unsupported' || result.error === 'unknown_platform') {
        return format(t.sendFileUnsupported, { platform: target.platform });
      }
      if (result.error?.includes('rate_limited')) {
        return t.sendFileRateLimited;
      }
      return format(t.sendFileError, { error: result.error ?? 'unknown' });
    } catch (err) {
      return format(t.sendFileError, { error: err instanceof Error ? err.message : String(err) });
    }
  },
  // Network side effect (upload + send): must not run concurrently with others.
  isConcurrencySafe: false,
};
