import { renderToStaticMarkup } from 'react-dom/server';
import { ImageLayers } from './ImageLayers';
import type { ImageEditDraft } from '@/types/media';

export function imageLayerSvg(draft: Pick<ImageEditDraft, 'source' | 'comments' | 'markup' | 'region'>, mode: 'markup' | 'mask'): string {
  const { width, height } = draft.source;
  return renderToStaticMarkup(<svg xmlns="http://www.w3.org/2000/svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
    <ImageLayers width={width} height={height} comments={draft.comments} markup={draft.markup} region={draft.region} mode={mode} maskId="edit-region" />
  </svg>);
}
