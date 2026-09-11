import type { DetailBlock } from '@/types/execution';
import { getToolLabel } from '@/utils/toolLabels';
import type { BatchTaskStep } from '@/stores/batchProgressStore';
import type { UnifiedStep } from './TaskBlock';

export function toUnifiedBatchStep(step: BatchTaskStep, locale: string): UnifiedStep {
  const image = step.resultContent?.find((block) => block.type === 'image');
  const detailBlocks: DetailBlock[] | undefined = image?.type === 'image'
    ? [{
      id: `${step.id}-image`,
      stepId: step.id,
      type: 'image',
      label: '',
      labelKey: 'image',
      content: step.result ?? '',
      imageData: { mediaType: image.source.media_type, base64: image.source.data },
      isTruncated: false,
      isExpanded: true,
    }]
    : undefined;

  return {
    id: step.id,
    type: 'tool',
    label: getToolLabel(step.toolName, step.toolInput, locale).label,
    status: step.status,
    duration: step.endTime === undefined ? undefined : (step.endTime - step.startTime) / 1000,
    toolName: step.toolName,
    toolInput: step.toolInput,
    toolResult: step.result,
    detailBlocks,
    showLegacyDetailsWithDetailBlocks: detailBlocks !== undefined,
  };
}
