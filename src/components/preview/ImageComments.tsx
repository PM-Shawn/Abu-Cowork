import { useLayoutEffect, useRef, type CSSProperties } from 'react';
import { IconButton } from '@/components/ds/button';
import { AppIcons } from '@/components/ds/icons';
import { belongsToInputMethod } from '@/components/ds/heldKey';
import { Popover } from '@/components/ds/popover';
import { Pressable } from '@/components/ds/pressable';
import { TextArea } from '@/components/ds/text-area';
import { useI18n } from '@/i18n';
import type { ImageComment } from '@/types/media';

function CommentInput({ comment, label, onChange, onClose, onDelete }: {
  comment: ImageComment;
  label: string;
  onChange: (text: string) => void;
  onClose: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const field = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const element = field.current;
    if (!element) return;
    element.focus({ preventScroll: true });
    element.setSelectionRange(element.value.length, element.value.length);
  }, []);
  return <>
    <TextArea ref={field} aria-label={label} rows={2} value={comment.text}
      placeholder={t.media.commentPlaceholder} onChange={event => onChange(event.target.value)}
      onKeyDown={event => {
        if (event.key === 'Enter' && !event.shiftKey && !belongsToInputMethod(event)) {
          event.preventDefault();
          if (!event.repeat) onClose();
        }
      }} />
    <div className="mt-1 flex items-center justify-between">
      <span className="text-caption text-label-secondary">{label}</span>
      <div className="flex gap-1">
        <IconButton size="sm" icon={AppIcons.delete} label={t.common.delete} onClick={onDelete} />
        <IconButton size="sm" icon={AppIcons.done} label={t.common.save} onClick={onClose} />
      </div>
    </div>
  </>;
}

export function ImageComments({ comments, editor, width, height, zoom, rotation, offset, onOpen, onClose, onChange, onDelete, onFocusUnplaced }: {
  comments: ImageComment[];
  editor?: { id: string; open: boolean };
  width: number;
  height: number;
  zoom: number;
  rotation: number;
  offset: { x: number; y: number };
  onOpen: (id: string) => void;
  onClose: (id: string) => void;
  onChange: (id: string, text: string) => void;
  onDelete: (id: string) => void;
  onFocusUnplaced: () => void;
}) {
  const { t } = useI18n();
  const selected = comments.find(comment => comment.id === editor?.id);
  const angle = rotation * Math.PI / 180;
  const position = (comment: ImageComment): CSSProperties => {
    const x = (comment.point.x - 0.5) * width * zoom;
    const y = (comment.point.y - 0.5) * height * zoom;
    return {
      left: '50%', top: '50%',
      transform: `translate(${offset.x + x * Math.cos(angle) - y * Math.sin(angle)}px, ${offset.y + x * Math.sin(angle) + y * Math.cos(angle)}px) translate(-50%, -50%)`,
    };
  };
  const label = (comment: ImageComment) => `${t.media.comment} ${comments.indexOf(comment) + 1}`;
  const marker = (comment: ImageComment) => <Pressable
    key={comment.id} aria-label={label(comment)} aria-expanded={comment.id === editor?.id && editor.open}
    className="pointer-events-auto absolute flex h-7 min-w-7 items-center justify-center rounded-control border border-surface bg-emphasis px-1 text-caption text-on-emphasis shadow-panel"
    style={position(comment)} onClick={comment.id === selected?.id ? undefined : () => onOpen(comment.id)}
  >{comments.indexOf(comment) + 1}</Pressable>;

  // One floating editor serves every marker. Its controls stay upright at every image rotation.
  return <div className="pointer-events-none absolute inset-0" onPointerDown={event => event.stopPropagation()}
    onPointerMove={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()}
    onDoubleClick={event => event.stopPropagation()}>
    {comments.filter(comment => comment.id !== selected?.id).map(marker)}
    {selected && <Popover open={editor?.open} onOpenChange={open => open ? onOpen(selected.id) : onClose(selected.id)}
      trigger={marker(selected)} label={label(selected)} side="right" align="start"
      className="pointer-events-auto p-2" contentProps={{ 'data-testid': 'image-comment-editor' }}>
      <CommentInput key={selected.id} comment={selected} label={label(selected)}
        onChange={text => onChange(selected.id, text)} onClose={() => onClose(selected.id)}
        onDelete={() => { onFocusUnplaced(); onDelete(selected.id); }} />
    </Popover>}
  </div>;
}
