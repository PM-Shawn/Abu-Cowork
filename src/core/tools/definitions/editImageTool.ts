import type { ToolDefinition } from '@/types';
import { executeImageEdit } from '@/core/media/mediaJobs';
import { TOOL_NAMES } from '../toolNames';

export const editImageTool: ToolDefinition = {
  name: TOOL_NAMES.EDIT_IMAGE,
  description: 'Execute a user-submitted image edit by its request ID. The application holds the original image, comments, drawing and selection. Use the exact request ID supplied with the user message. The same ID returns the existing job and never starts another paid generation.',
  inputSchema: { type: 'object', properties: { request_id: { type: 'string', description: 'The request ID attached to the user message.' } }, required: ['request_id'] },
  execute: async (input, context) => {
    if (!context?.conversationId || typeof input.request_id !== 'string') throw new Error('Image edit requires an originating conversation and request');
    const record = await executeImageEdit(context.conversationId, input.request_id);
    if (record.job.generationState !== 'completed') {
      const reason = record.job.error ? ` Reason: ${record.job.error}. Explain this cause to the user.` : '';
      return `Image edit status: ${record.job.generationState}.${reason} This request has already been submitted; do not submit it again.`;
    }
    return `Image edit completed. The application has displayed ${record.artifacts.length} image result(s) in this conversation. Do not duplicate the files in the reply.`;
  },
  isConcurrencySafe: true,
};
