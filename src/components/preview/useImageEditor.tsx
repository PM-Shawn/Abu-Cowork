import { useEffect, useRef, useState } from 'react';
import { Button, IconButton } from '@/components/ds/button';
import { Menu, MenuItem } from '@/components/ds/menu';
import { TextField } from '@/components/ds/text-field';
import { Slider } from '@/components/ds/slider';
import { AppIcons } from '@/components/ds/icons';
import { useI18n } from '@/i18n';
import { useEnterpriseStore } from '@/stores/enterpriseStore';
import { findImageEditEntry, useImageEditStore } from '@/stores/imageEditStore';
import { useToastStore } from '@/stores/toastStore';
import { getComposerDraftKey, getComposerDraftScopeForEnterpriseMode, readComposerDraft, writeComposerDraft } from '@/stores/composerDraftStore';
import { activateImageEditing } from '@/core/media/imageEditing';
import { IMAGE_ASPECT_RATIOS, setImageAspectRatioPrompt } from '@/core/media/imageDraft';
import { ImageLayers } from '@/core/media/ImageLayers';
import { focusComposerFromWindow } from '@/components/chat/composerFocus';
import { useMediaFile } from '@/hooks/useMediaFile';
import type { ImageAspectRatio, ImageEditTool, ImageMarkup, ImagePoint, ImageRegionStroke, MediaFileRef } from '@/types/media';

export function useImageEditor(conversationId?: string, filePath?: string, fileRef?: MediaFileRef) {
  const { t } = useI18n();
  const scope = useEnterpriseStore(state => getComposerDraftScopeForEnterpriseMode(state.mode));
  const composerKey = getComposerDraftKey(conversationId ?? null, scope);
  const entry = useImageEditStore(state => findImageEditEntry(state, composerKey, filePath, fileRef?.captureId));
  const key = entry?.key ?? `${composerKey}\0${filePath}${fileRef?.captureId ? `\0${fileRef.captureId}` : ''}`;
  const active = useImageEditStore(state => state.active[composerKey] === key);
  const media = useMediaFile(entry ? entry.draft.conversationId : '', entry?.draft.source.fileRef.originalPath ?? filePath ?? '', 0, entry?.draft.source.fileRef);
  const [busy, setBusy] = useState(false);
  const [shape, setShape] = useState<ImageMarkup['kind']>('pen');
  const [color, setColor] = useState('#e54343');
  const [width, setWidth] = useState(0.012);
  const [erase, setErase] = useState(false);
  const [label, setLabel] = useState('');
  const [stroke, setStroke] = useState<ImageMarkup | ImageRegionStroke>();
  const pendingStroke = useRef<ImageMarkup | ImageRegionStroke | undefined>(undefined);
  const ratioChosen = useRef(false);
  const [commentEditor, setCommentEditor] = useState<{ id: string; open: boolean }>();
  useEffect(() => { pendingStroke.current = undefined; setStroke(undefined); setCommentEditor(undefined); }, [key]);

  const activate = async (tool: ImageEditTool) => {
    if (!conversationId || !filePath) return false;
    setCommentEditor(current => current && { ...current, open: false });
    if (active && entry) { useImageEditStore.getState().selectTool(key, tool); return true; }
    setBusy(true);
    try { return await activateImageEditing({ composerKey, conversationId, scope, filePath, fileRef, tool }); }
    finally { setBusy(false); }
  };
  const run = (action: Promise<unknown>) => void action.then(undefined, error => {
    useToastStore.getState().addToast({ type: 'error', title: t.media.editUnavailable, message: error instanceof Error ? error.message : String(error) });
  });
  const setRatio = async (ratio: ImageAspectRatio) => {
    if (!await activate(entry?.draft.activeTool ?? 'prompt')) return;
    const current = readComposerDraft(composerKey);
    const text = setImageAspectRatioPrompt(current.text, ratio, t.media.ratioPrompt);
    writeComposerDraft(composerKey, { ...current, text });
    const activeKey = useImageEditStore.getState().active[composerKey];
    useImageEditStore.getState().setPrompt(activeKey, text);
    focusComposerFromWindow();
  };
  const store = useImageEditStore.getState();
  const tool = active ? entry?.draft.activeTool : undefined;
  const drawing = tool !== undefined && tool !== 'prompt' && Boolean(media?.grant);
  const setPending = (value?: ImageMarkup | ImageRegionStroke) => { pendingStroke.current = value; setStroke(value); };

  const pointerDown = (point: ImagePoint) => {
    if (!entry || !drawing) return;
    if (tool === 'comments') {
      const id = crypto.randomUUID();
      store.changeLayer(key, 'comments', [...entry.draft.comments, { id, point, text: '' }]);
      setCommentEditor({ id, open: true });
      return;
    }
    const id = crypto.randomUUID();
    if (tool === 'region') setPending({ id, erase, width: width * 4, points: [point] });
    else if (shape === 'text') {
      if (label.trim()) store.changeLayer(key, 'markup', [...entry.draft.markup, { id, kind: 'text', point, text: label, color, width }]);
    } else if (shape === 'pen') setPending({ id, kind: 'pen', points: [point], color, width });
    else setPending({ id, kind: shape, start: point, end: point, color, width });
  };
  const pointerMove = (point: ImagePoint) => {
    const current = pendingStroke.current;
    if (!current) return;
    if ('points' in current) setPending({ ...current, points: [...current.points, point] });
    else if ('end' in current) setPending({ ...current, end: point });
  };
  const pointerUp = () => {
    const current = pendingStroke.current;
    const latest = useImageEditStore.getState().entries[key];
    if (current && latest) {
      if ('erase' in current) store.changeLayer(key, 'region', [...latest.draft.region, current]);
      else store.changeLayer(key, 'markup', [...latest.draft.markup, current]);
    }
    setPending();
  };
  const tools: [ImageEditTool, string][] = [['prompt', t.media.editImage], ['comments', t.media.comments], ['markup', t.media.markup], ['region', t.media.region]];
  const shapes: [ImageMarkup['kind'], string][] = [['pen', t.media.pen], ['arrow', t.media.arrow], ['rectangle', t.media.rectangle], ['text', t.media.text]];

  const controls = conversationId && filePath ? <div className="flex flex-col gap-2">
    {(tool === 'markup' || tool === 'region') && <div className="flex flex-wrap items-center gap-2 rounded-panel bg-raised p-2">
      {tool === 'markup' ? <>
        <Menu side="top" trigger={<Button size="sm" variant="secondary">{shapes.find(([kind]) => kind === shape)?.[1]}</Button>}>
          {shapes.map(([kind, title]) => <MenuItem key={kind} onSelect={() => setShape(kind)}>{title}</MenuItem>)}
        </Menu>
        <TextField aria-label={t.media.color} type="color" value={color} onChange={event => setColor(event.target.value)} className="w-10 p-1" />
        {shape === 'text' && <TextField aria-label={t.media.text} value={label} onChange={event => setLabel(event.target.value)} className="min-w-0 flex-1" />}
      </> : <Button size="sm" variant="secondary" aria-pressed={erase} onClick={() => setErase(value => !value)}>{t.media.eraser}</Button>}
      <div className="w-20"><Slider label={t.media.brushSize} min={0.002} max={0.04} step={0.002} value={width} onValueChange={setWidth} /></div>
      <IconButton size="sm" icon={AppIcons.undo} label={t.media.undo} disabled={!entry?.history.past.length} onClick={() => store.travel(key, 'undo')} />
      <IconButton size="sm" icon={AppIcons.redo} label={t.media.redo} disabled={!entry?.history.future.length} onClick={() => store.travel(key, 'redo')} />
      <Button size="sm" variant="plain" onClick={() => store.changeLayer(key, tool, [])}>{t.media.clear}</Button>
    </div>}
    <div className="flex flex-wrap items-center justify-center gap-1">
      {tools.map(([value, title]) => <Button key={value} size="sm" variant="plain" busy={busy} aria-pressed={tool === value} onClick={() => run(activate(value))}>{title}</Button>)}
      <Menu side="top" trigger={<Button size="sm" variant="plain" busy={busy}>{t.media.ratio}</Button>} onCloseAutoFocus={event => {
        if (!ratioChosen.current) return;
        event.preventDefault(); ratioChosen.current = false; focusComposerFromWindow();
      }}>
        {IMAGE_ASPECT_RATIOS.map(ratio => <MenuItem key={ratio} onSelect={() => { ratioChosen.current = true; run(setRatio(ratio)); }}>{ratio}</MenuItem>)}
      </Menu>
    </div>
  </div> : null;

  return {
    controls, drawing, sourceUrl: media?.grant?.url,
    comments: entry?.draft.comments ?? [],
    commentEditor: commentEditor && { ...commentEditor, open: commentEditor.open && tool === 'comments' },
    openComment: (id: string) => {
      run(activate('comments').then(activated => {
        if (activated) setCommentEditor({ id, open: true });
      }));
    },
    closeComment: (id: string) => setCommentEditor(current => current?.id === id ? { ...current, open: false } : current),
    changeComment: (id: string, text: string) => {
      const current = useImageEditStore.getState().entries[key];
      store.changeLayer(key, 'comments', current.draft.comments.map(comment => comment.id === id ? { ...comment, text } : comment));
    },
    deleteComment: (id: string) => {
      const current = useImageEditStore.getState().entries[key];
      store.changeLayer(key, 'comments', current.draft.comments.filter(comment => comment.id !== id));
      setCommentEditor(undefined);
    },
    pointerDown, pointerMove, pointerUp, pointerCancel: () => setPending(),
    overlay: entry ? <ImageLayers width={entry.draft.source.width} height={entry.draft.source.height}
      comments={[]} markup={stroke && 'kind' in stroke ? [...entry.draft.markup, stroke] : entry.draft.markup}
      region={stroke && 'erase' in stroke ? [...entry.draft.region, stroke] : entry.draft.region} mode="preview" maskId={`selection-${entry.draft.sourceCaptureId}`} /> : null,
    dimensions: entry ? { width: entry.draft.source.width, height: entry.draft.source.height } : undefined,
  };
}
