import { useState } from 'react';
import { Button } from '@/components/ds/button';
import { useConfirm } from '@/components/ds/confirm-context';
import { ContextMenu } from '@/components/ds/context-menu';
import { Dialog, DialogClose } from '@/components/ds/dialog';
import { AppIcons } from '@/components/ds/icons';
import { Menu, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuSub } from '@/components/ds/menu';
import { Popover } from '@/components/ds/popover';
import { Select } from '@/components/ds/select';
import { TextField } from '@/components/ds/text-field';
import { Tooltip } from '@/components/ds/tooltip';
import { Section } from './Section';
import { PREVIEW_MODELS } from './specimen';

// Enough lines to be taller than a small window, so the dialog scrolls inside.
const SCROLL_LINES = Array.from({ length: 30 }, (_, index) => `Line ${index + 1} of 30`);

export function OverlaySection() {
  const confirm = useConfirm();
  const [renameOpen, setRenameOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [popoverModel, setPopoverModel] = useState('opus');
  const [answer, setAnswer] = useState('none yet');
  const [menuTheme, setMenuTheme] = useState('system');
  const [dialogModel, setDialogModel] = useState('sonnet');
  const [pageModel, setPageModel] = useState('opus');
  const [busyOpen, setBusyOpen] = useState(false);
  const [busyDraft, setBusyDraft] = useState('');
  const [approval, setApproval] = useState<'none' | 'first' | 'second'>('none');

  const askToDelete = async () => {
    const confirmed = await confirm({
      title: 'Delete this channel?',
      message: 'Messages already sent stay in the task.',
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    setAnswer(confirmed ? 'deleted' : 'kept');
  };

  const askToArchive = async () => {
    const confirmed = await confirm({
      title: 'Move this task to the archive?',
      message: 'You can bring it back from the archive at any time.',
      confirmLabel: 'Move',
    });
    setAnswer(confirmed ? 'archived' : 'kept');
  };

  return (
    <Section id="overlays" title="Menus, popovers and dialogs">
      <div className="flex flex-wrap items-center gap-3">
        <Menu trigger={<Button icon={AppIcons.more}>Menu</Button>}>
          <MenuLabel>Task</MenuLabel>
          <MenuItem icon={AppIcons.rename} shortcut="⌘R">Rename</MenuItem>
          <MenuItem icon={AppIcons.copy}>Copy link</MenuItem>
          <MenuItem icon={AppIcons.history} description="Before AI edit · 2.1 KB">Restore 10:24:31</MenuItem>
          <MenuItem icon={AppIcons.share} disabled>Share (not available)</MenuItem>
          <MenuSub icon={AppIcons.folder} label="Move to">
            <MenuItem icon={AppIcons.folder}>Launch plan</MenuItem>
            <MenuItem icon={AppIcons.folder}>Weekly report</MenuItem>
          </MenuSub>
          <MenuSub icon={AppIcons.appearance} label="Appearance">
            <MenuRadioGroup value={menuTheme} onValueChange={setMenuTheme}>
              <MenuRadioItem value="system">System</MenuRadioItem>
              <MenuRadioItem value="light">Light</MenuRadioItem>
              <MenuRadioItem value="dark">Dark</MenuRadioItem>
            </MenuRadioGroup>
          </MenuSub>
          <MenuSeparator />
          <MenuItem icon={AppIcons.delete} tone="danger">Delete</MenuItem>
        </Menu>
        <ContextMenu content={<><MenuItem icon={AppIcons.copy}>Copy</MenuItem><MenuItem icon={AppIcons.share}>Share</MenuItem></>}>
          <div className="rounded-panel border border-separator px-3 py-2 text-ui-sm text-label-secondary">Right-click here</div>
        </ContextMenu>
        <Popover trigger={<Button>Popover</Button>}>
          <div className="flex flex-col gap-2">
            <p>A select inside a popover leaves the popover open.</p>
            <Select label="Model inside popover" value={popoverModel} onValueChange={setPopoverModel} options={PREVIEW_MODELS} />
          </div>
        </Popover>
        <Tooltip content="Show a tooltip"><Button>Hover for a tooltip</Button></Tooltip>
        <Button onClick={() => setRenameOpen(true)}>Dialog</Button>
        <Dialog
          open={renameOpen}
          onOpenChange={setRenameOpen}
          title="Rename task"
          description="Type something, then press Escape to see the discard question."
          dirty={draft !== ''}
          footer={(
            <>
              <DialogClose asChild><Button>Cancel</Button></DialogClose>
              <Button variant="primary" onClick={() => { setDraft(''); setRenameOpen(false); }}>Save</Button>
            </>
          )}
        >
          <TextField aria-label="New name" placeholder="New name" value={draft} onChange={(event) => setDraft(event.target.value)} />
        </Dialog>
        <Dialog
          size="sm"
          title="Small dialog"
          description="The narrow width, for short questions."
          trigger={<Button>Small dialog</Button>}
          footer={<DialogClose asChild><Button variant="primary">Done</Button></DialogClose>}
        />
        <Dialog
          size="lg"
          title="Large dialog"
          description="The wide width, for forms and lists."
          trigger={<Button>Large dialog</Button>}
          footer={<DialogClose asChild><Button variant="primary">Done</Button></DialogClose>}
        >
          <TextField aria-label="Folder path" placeholder="Folder path" />
        </Dialog>
        <Dialog
          size="lg"
          title="Search"
          titleHidden
          trigger={<Button>Dialog without a visible title</Button>}
        >
          <TextField aria-label="Search tasks" placeholder="Search tasks..." />
        </Dialog>
        <Dialog
          size="lg"
          title="Dialog with a select inside"
          description="The list and the menu open above the dialog; the lines scroll inside it."
          closeButton
          trigger={<Button>Dialog with a select inside</Button>}
          footer={<DialogClose asChild><Button variant="primary">Done</Button></DialogClose>}
        >
          <div className="flex items-center gap-3">
            <Select label="Model inside dialog" value={dialogModel} onValueChange={setDialogModel} options={PREVIEW_MODELS} />
            <Menu trigger={<Button icon={AppIcons.more}>Menu inside dialog</Button>}>
              <MenuItem icon={AppIcons.rename}>Rename</MenuItem>
              <MenuSub icon={AppIcons.folder} label="Move to">
                <MenuItem icon={AppIcons.folder}>Launch plan</MenuItem>
              </MenuSub>
            </Menu>
            <Tooltip content="Show a tooltip above the dialog"><Button>Hover inside dialog</Button></Tooltip>
          </div>
          <div className="mt-3 flex flex-col gap-1">
            {SCROLL_LINES.map((line) => <p key={line}>{line}</p>)}
          </div>
        </Dialog>
        <Dialog
          size="page"
          title="Settings"
          titleHidden
          closeButton
          trigger={<Button>Settings-size dialog</Button>}
        >
          <div className="flex h-full">
            <div className="w-56 shrink-0 border-r border-separator p-3 text-ui-sm text-label-secondary">Navigation</div>
            <div className="min-w-0 flex-1 p-6">
              <p className="text-title text-label">Settings-size dialog</p>
              <div className="mt-4">
                <Select label="Model inside the settings-size dialog" value={pageModel} onValueChange={setPageModel} options={PREVIEW_MODELS} />
              </div>
            </div>
          </div>
        </Dialog>
        <Button variant="danger" onClick={() => { void askToDelete(); }}>Confirm dialog</Button>
        <Button onClick={() => { void askToArchive(); }}>Confirm (default tone)</Button>
        <span className="text-ui-sm text-label-secondary">{`Last answer: ${answer}`}</span>
        <Button onClick={() => setBusyOpen(true)}>Busy window</Button>
        <Dialog
          open={busyOpen}
          onOpenChange={setBusyOpen}
          busy
          title="Busy window"
          description="Work is in flight here. An approval makes this window step aside; it returns as it was."
          footer={<DialogClose asChild><Button>Close</Button></DialogClose>}
        >
          <div className="flex flex-col gap-3">
            <TextField aria-label="Typed while busy" placeholder="Type something" value={busyDraft} onChange={(event) => setBusyDraft(event.target.value)} />
            <Button onClick={() => setApproval('first')}>Approval arrives</Button>
          </div>
        </Dialog>
        <Dialog
          open={approval === 'first'}
          onOpenChange={(open) => { if (!open) setApproval('none'); }}
          layer="approval"
          role="alertdialog"
          outsidePress="ignore"
          closeButton
          title="Run this command?"
          description="Only its own buttons, Escape and the close button answer an approval."
          initialFocus={(content) => content.querySelector('[data-approval-cancel]')}
          footer={(
            <>
              <Button data-approval-cancel="" onClick={() => setApproval('none')}>Cancel</Button>
              <Button onClick={() => setRenameOpen(true)}>Open a dialog</Button>
              <Button variant="primary" onClick={() => setApproval('second')}>Next approval</Button>
            </>
          )}
        />
        <Dialog
          open={approval === 'second'}
          onOpenChange={(open) => { if (!open) setApproval('none'); }}
          layer="approval"
          role="alertdialog"
          outsidePress="ignore"
          title="Allow this folder?"
          initialFocus={(content) => content.querySelector('[data-approval-cancel]')}
          footer={<Button data-approval-cancel="" onClick={() => setApproval('none')}>Deny</Button>}
        />
      </div>
    </Section>
  );
}
