import { useState } from 'react';
import { Button } from '@/components/ds/button';
import { useConfirm } from '@/components/ds/confirm-context';
import { ContextMenu } from '@/components/ds/context-menu';
import { Dialog, DialogClose } from '@/components/ds/dialog';
import { AppIcons } from '@/components/ds/icons';
import { Menu, MenuItem, MenuLabel, MenuSeparator, MenuSub } from '@/components/ds/menu';
import { Popover } from '@/components/ds/popover';
import { Select } from '@/components/ds/select';
import { TextField } from '@/components/ds/text-field';
import { Tooltip } from '@/components/ds/tooltip';
import { Section } from './Section';
import { PREVIEW_MODELS } from './specimen';

export function OverlaySection() {
  const confirm = useConfirm();
  const [renameOpen, setRenameOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [popoverModel, setPopoverModel] = useState('opus');
  const [answer, setAnswer] = useState('none yet');

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
          <MenuItem icon={AppIcons.share} disabled>Share (not available)</MenuItem>
          <MenuSub icon={AppIcons.folder} label="Move to">
            <MenuItem icon={AppIcons.folder}>Launch plan</MenuItem>
            <MenuItem icon={AppIcons.folder}>Weekly report</MenuItem>
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
        <Button variant="danger" onClick={() => { void askToDelete(); }}>Confirm dialog</Button>
        <Button onClick={() => { void askToArchive(); }}>Confirm (default tone)</Button>
        <span className="text-ui-sm text-label-secondary">{`Last answer: ${answer}`}</span>
      </div>
    </Section>
  );
}
