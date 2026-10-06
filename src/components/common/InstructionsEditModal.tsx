import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { readTextFile, writeTextFile, exists, mkdir } from '@tauri-apps/plugin-fs';
import { Button } from '@/components/ds/button';
import { Dialog, DialogClose } from '@/components/ds/dialog';
import { InlineMessage } from '@/components/ds/inline-message';
import { lastInputWasPointer } from '@/components/ds/input-modality';
import { Spinner } from '@/components/ds/spinner';
import { TextArea } from '@/components/ds/text-area';
import { useI18n } from '@/i18n';
import { joinPath } from '@/utils/pathUtils';

interface InstructionsEditModalProps {
  open: boolean;
  onClose: () => void;
  workspacePath: string;
}

export default function InstructionsEditModal({ open, onClose, workspacePath }: InstructionsEditModalProps) {
  const { t } = useI18n();
  const [content, setContent] = useState('');
  // The text as it was read from the file: the text differs from it once something was typed.
  const [loaded, setLoaded] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The window shows the file of one folder for one opening. It starts over when it opens and
  // when the folder changes while it is open, so the text on screen is always the text of the
  // folder a save writes to. Once closed it keeps what it showed while it fades out.
  const shownFor = open ? workspacePath : null;
  const [filledFor, setFilledFor] = useState<string | null>(null);
  if (shownFor !== filledFor) {
    setFilledFor(shownFor);
    if (shownFor !== null) {
      setLoading(true);
      setContent('');
      setLoaded('');
      setError(null);
    }
  }

  // Counts the openings (a folder change is one too): a save belongs to the opening it was started in.
  const opening = useRef(0);
  const isOpen = useRef(open);
  // True from the start of an opening until its text field has appeared.
  const fieldFocusDue = useRef(false);
  useLayoutEffect(() => {
    isOpen.current = open;
    if (!open) return;
    opening.current += 1;
    fieldFocusDue.current = true;
  }, [open, workspacePath]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    async function loadContent() {
      let text = '';
      try {
        const abuMdPath = joinPath(workspacePath, '.abu', 'ABU.md');
        if (await exists(abuMdPath)) text = await readTextFile(abuMdPath);
      } catch {
        text = '';
      }
      // A read of an earlier opening, or of the folder shown before, is dropped.
      if (cancelled) return;
      setContent(text);
      setLoaded(text);
      setLoading(false);
    }
    void loadContent();
    return () => { cancelled = true; };
  }, [open, workspacePath]);

  // The window opens while the file is being read, with no text field yet, so its first focus
  // is on Cancel. The field takes the focus once, when it appears, unless the user has moved
  // the focus to another control meanwhile.
  const cancelRef = useRef<HTMLButtonElement>(null);
  const focusField = useCallback((field: HTMLTextAreaElement | null) => {
    if (!field || !fieldFocusDue.current) return;
    fieldFocusDue.current = false;
    const active = document.activeElement;
    const onNoOtherControl = active === cancelRef.current || active === document.body
      || (active instanceof HTMLElement && active.hasAttribute('data-ds-layer') && active.contains(field));
    if (!isOpen.current || !onNoOtherControl) return;
    field.focus({ preventScroll: true, ...(lastInputWasPointer() ? { focusVisible: false } : {}) });
  }, []);

  const savingRef = useRef(false);
  const handleSave = async () => {
    // The window keeps rendering while it fades out: nothing is saved then. One save at a time.
    if (!open || loading || savingRef.current) return;
    const mine = opening.current;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const abuDir = joinPath(workspacePath, '.abu');
      if (!(await exists(abuDir))) {
        await mkdir(abuDir, { recursive: true });
      }
      const abuMdPath = joinPath(abuDir, 'ABU.md');
      await writeTextFile(abuMdPath, content);
      // A window that was closed meanwhile is reported closed again: the owner then looks for
      // the file that now exists. A later opening is not closed by this save.
      if (opening.current === mine) onClose();
    } catch (err) {
      console.error('Failed to save instructions:', err);
      // The message belongs to the opening that saved, and a window that is fading out shows nothing new.
      if (opening.current === mine && isOpen.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!next) onClose(); }}
      title={t.panel.instructionsTitle}
      description={t.panel.instructionsDesc}
      size="md"
      closeButton
      dirty={content !== loaded}
      // Closing never stops a save, but a window closed for an approval would not show a failed one.
      busy={saving}
      footer={(
        <>
          <DialogClose asChild><Button ref={cancelRef} variant="plain">{t.common.cancel}</Button></DialogClose>
          <Button variant="primary" busy={saving} disabled={loading} onClick={handleSave}>
            {saving ? t.panel.instructionsSaving : t.common.save}
          </Button>
        </>
      )}
    >
      {loading ? (
        <div className="flex justify-center py-8">
          <Spinner label={t.common.loading} />
        </div>
      ) : (
        <TextArea
          ref={focusField}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder={t.panel.instructionsPlaceholder}
          className="min-h-50 max-h-100 font-code"
        />
      )}

      {error && (
        <div className="mt-3">
          <InlineMessage tone="danger">
            <div className="font-medium">{t.panel.instructionsSaveFailed}</div>
            <div className="break-words">{error}</div>
          </InlineMessage>
        </div>
      )}
    </Dialog>
  );
}
