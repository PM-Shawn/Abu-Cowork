import { useId, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@/components/ds/button';
import { Dialog, DialogClose } from '@/components/ds/dialog';
import { InlineMessage } from '@/components/ds/inline-message';
import { SegmentedControl } from '@/components/ds/segmented-control';
import { TextArea } from '@/components/ds/text-area';
import { TextField } from '@/components/ds/text-field';
import { useI18n } from '@/i18n';

/** What the form holds, as text: each field is what the user typed. */
export interface MCPServerFormValues {
  name: string;
  transport: 'stdio' | 'http';
  command: string;
  args: string;
  env: string;
  url: string;
  headers: string;
}

export interface MCPServerFormDialogProps {
  open: boolean;
  mode: 'add' | 'edit';
  /** The connector being edited, or null while adding. */
  editingServerName: string | null;
  values: MCPServerFormValues;
  onChange: (patch: Partial<MCPServerFormValues>) => void;
  addMode: 'form' | 'json';
  onAddModeChange: (mode: 'form' | 'json') => void;
  jsonInput: string;
  onJsonInputChange: (value: string) => void;
  serverNameError: string;
  jsonError: string;
  /** Set when the connector keeps its name (a catalog or plugin connector): the name field is locked and this says why. */
  nameLockedHint?: string;
  /** Changes when the owner fills the open form itself (a catalog entry): what the form then holds is its new starting point. */
  startingPoint?: number;
  onSubmit: () => void | Promise<void>;
  onClose: () => void;
  /** Runs once the window has gone; `event.preventDefault()` there keeps the focus from returning to the control that opened it. */
  onCloseAutoFocus?: (event: Event) => void;
}

/** What the user can lose by closing the window. */
interface Draft {
  values: MCPServerFormValues;
  jsonInput: string;
}

/** Everything the window shows. */
interface Content extends Draft {
  mode: 'add' | 'edit';
  addMode: 'form' | 'json';
  serverNameError: string;
  jsonError: string;
  nameLockedHint: string | undefined;
}

const VALUE_KEYS: (keyof MCPServerFormValues)[] = ['name', 'transport', 'command', 'args', 'env', 'url', 'headers'];

const sameDraft = (a: Draft, b: Draft) => a.jsonInput === b.jsonInput && VALUE_KEYS.every((key) => a.values[key] === b.values[key]);

const sameContent = (a: Content | null, b: Content) => a !== null
  && sameDraft(a, b)
  && a.mode === b.mode
  && a.addMode === b.addMode
  && a.serverNameError === b.serverNameError
  && a.jsonError === b.jsonError
  && a.nameLockedHint === b.nameLockedHint;

const LABEL = 'mb-1 block text-ui-sm font-medium text-label-secondary';

/**
 * The window that adds a connector or edits one: a form, or the same config pasted as JSON.
 * Its owner holds the fields and does the adding; the window shows them, says when a typed
 * draft would be lost, and hands a submit over once.
 */
export default function MCPServerFormDialog({
  open, mode, values, onChange, addMode, onAddModeChange, jsonInput, onJsonInputChange,
  serverNameError, jsonError, nameLockedHint, startingPoint = 0, onSubmit, onClose, onCloseAutoFocus,
}: MCPServerFormDialogProps) {
  const { t } = useI18n();
  const id = useId();
  const draft: Draft = { values, jsonInput };
  const content: Content = { ...draft, mode, addMode, serverNameError, jsonError, nameLockedHint };

  // What the form held when it opened, or when its owner last filled it: the window asks before
  // closing once the draft differs. It can hold Env and Headers values, so it lives in memory only
  // and is dropped once the window has gone.
  const [baseline, setBaseline] = useState<Draft | null>(null);
  const [wasOpen, setWasOpen] = useState(false);
  const [seenStartingPoint, setSeenStartingPoint] = useState(startingPoint);
  // The submit this window started is still running. A window that opens again starts ready.
  const [busy, setBusy] = useState(false);
  if (open !== wasOpen || (open && seenStartingPoint !== startingPoint)) {
    setWasOpen(open);
    setSeenStartingPoint(startingPoint);
    if (open) setBaseline(draft);
    if (open !== wasOpen) setBusy(false);
  }
  // The window stays on the page while it fades out and keeps showing what it held; its owner
  // has emptied the fields by then. Dropped with the baseline.
  const [held, setHeld] = useState<Content | null>(null);
  if (open && !sameContent(held, content)) setHeld(content);
  const shown = open ? content : held ?? content;
  const dirty = open && baseline !== null && !sameDraft(draft, baseline);

  // Each opening is a run of its own: a submit left running by an earlier one (the connection
  // it started can take a while) does not end the wait of this one.
  const run = useRef(0);
  useLayoutEffect(() => { run.current += 1; }, [open]);

  const submit = async () => {
    // The window stays on the page while it fades out; a key press there submits nothing.
    if (!open) return;
    const mine = run.current;
    setBusy(true);
    try {
      await onSubmit();
    } finally {
      if (run.current === mine) setBusy(false);
    }
  };

  const json = shown.addMode === 'json';
  const http = shown.values.transport === 'http';
  const incomplete = json
    ? !shown.jsonInput.trim()
    : !shown.values.name.trim() || (http ? !shown.values.url.trim() : !shown.values.command.trim());

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!next) onClose(); }}
      title={shown.mode === 'edit' ? t.toolbox.skillEdit : t.toolbox.addCustomServer}
      size="md"
      closeButton
      dirty={dirty}
      // The window opens on the first field that takes text, past the Form / JSON choice above it.
      initialFocus={(box) => box.querySelector<HTMLElement>('input:not([disabled]), textarea')}
      onCloseAutoFocus={(event) => {
        setBaseline(null);
        setHeld(null);
        onCloseAutoFocus?.(event);
      }}
      footer={(
        <>
          <DialogClose asChild><Button variant="plain">{t.common.cancel}</Button></DialogClose>
          <Button variant="primary" busy={busy} disabled={incomplete} onClick={() => void submit()}>
            {shown.mode === 'edit' ? t.common.save : t.toolbox.add}
          </Button>
        </>
      )}
    >
      <div className="flex flex-col gap-3">
        <div>
          <SegmentedControl
            label={t.toolbox.jsonConfigLabel}
            value={shown.addMode}
            onValueChange={(next) => onAddModeChange(next === 'json' ? 'json' : 'form')}
            options={[
              { value: 'form', label: t.toolbox.formMode },
              { value: 'json', label: t.toolbox.jsonMode },
            ]}
          />
        </div>

        {json ? (
          <div>
            <label htmlFor={`${id}-json`} className={LABEL}>{t.toolbox.jsonConfigLabel}</label>
            <TextArea
              id={`${id}-json`}
              className="font-code"
              rows={8}
              invalid={Boolean(shown.jsonError)}
              value={shown.jsonInput}
              onChange={(event) => onJsonInputChange(event.target.value)}
              placeholder={t.toolbox.jsonConfigPlaceholder}
            />
            <p className="mt-1 text-caption text-label-tertiary">{t.toolbox.jsonConfigHint}</p>
            {shown.jsonError && <div className="mt-2"><InlineMessage tone="danger">{shown.jsonError}</InlineMessage></div>}
          </div>
        ) : (
          <>
            <div>
              <label htmlFor={`${id}-name`} className={LABEL}>{t.toolbox.serverName}</label>
              <TextField
                id={`${id}-name`}
                placeholder={t.toolbox.serverName}
                value={shown.values.name}
                onChange={(event) => onChange({ name: event.target.value })}
                disabled={Boolean(shown.nameLockedHint)}
                invalid={Boolean(shown.serverNameError)}
              />
              {shown.serverNameError && <div className="mt-2"><InlineMessage tone="danger">{shown.serverNameError}</InlineMessage></div>}
              {shown.nameLockedHint && <p className="mt-1 text-caption text-label-tertiary">{shown.nameLockedHint}</p>}
            </div>
            <div>
              <div className={LABEL}>{t.toolbox.transportType}</div>
              <SegmentedControl
                label={t.toolbox.transportType}
                value={shown.values.transport}
                onValueChange={(next) => onChange({ transport: next === 'http' ? 'http' : 'stdio' })}
                options={[
                  { value: 'stdio', label: t.toolbox.transportStdio },
                  { value: 'http', label: t.toolbox.transportHttp },
                ]}
              />
            </div>
            {http ? (
              <>
                <div>
                  <label htmlFor={`${id}-url`} className={LABEL}>URL</label>
                  <TextField id={`${id}-url`} placeholder={t.toolbox.serverUrlPlaceholder} value={shown.values.url} onChange={(event) => onChange({ url: event.target.value })} />
                </div>
                <div>
                  <label htmlFor={`${id}-headers`} className={LABEL}>Headers (JSON)</label>
                  <TextField id={`${id}-headers`} className="font-code" placeholder={t.toolbox.serverHeadersPlaceholder} value={shown.values.headers} onChange={(event) => onChange({ headers: event.target.value })} />
                </div>
              </>
            ) : (
              <>
                <div>
                  <label htmlFor={`${id}-command`} className={LABEL}>{t.toolbox.serverCommand}</label>
                  <TextField id={`${id}-command`} placeholder={t.toolbox.serverCommand} value={shown.values.command} onChange={(event) => onChange({ command: event.target.value })} />
                </div>
                <div>
                  <label htmlFor={`${id}-args`} className={LABEL}>{t.toolbox.serverArgs}</label>
                  <TextField id={`${id}-args`} placeholder={t.toolbox.serverArgs} value={shown.values.args} onChange={(event) => onChange({ args: event.target.value })} />
                </div>
                <div>
                  <label htmlFor={`${id}-env`} className={LABEL}>Env (JSON)</label>
                  <TextField id={`${id}-env`} className="font-code" placeholder='{"API_KEY": "..."}' value={shown.values.env} onChange={(event) => onChange({ env: event.target.value })} />
                </div>
              </>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
