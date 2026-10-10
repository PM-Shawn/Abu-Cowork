import { useState } from 'react';
import { Checkbox } from '@/components/ds/checkbox';
import { Combobox, MultiCombobox, type ComboboxOption } from '@/components/ds/combobox';
import { AppIcons } from '@/components/ds/icons';
import { RadioGroup } from '@/components/ds/radio-group';
import { SegmentedControl } from '@/components/ds/segmented-control';
import { Select, type SelectOption } from '@/components/ds/select';
import { SettingGroup, SettingRow } from '@/components/ds/setting-row';
import { Slider } from '@/components/ds/slider';
import { Switch } from '@/components/ds/switch';
import { TextArea } from '@/components/ds/text-area';
import { TextField } from '@/components/ds/text-field';
import { Section } from './Section';
import { CJK_SPECIMEN, PREVIEW_MODELS } from './specimen';

const SITE_ACCESS: SelectOption[] = [
  { value: 'allow', label: 'Allow', tone: 'success', description: 'Abu opens the site without asking.' },
  { value: 'ask', label: 'Ask every time', icon: AppIcons.settings, description: 'Abu asks before it opens the site, each time a task needs it.' },
  { value: 'block', label: 'Block', tone: 'danger', description: 'Abu never opens the site.' },
];

const TEAM_MEMBERS: ComboboxOption[] = [
  { value: 'researcher', label: 'Researcher', description: 'Finds and reads the sources.' },
  { value: 'writer', label: 'Writer', description: 'Drafts the report from the notes.' },
  { value: 'reviewer', label: 'Reviewer', description: 'Checks the draft against the sources.' },
];

export function FormSection() {
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [attachments, setAttachments] = useState<boolean | 'indeterminate'>('indeterminate');
  const [notify, setNotify] = useState(true);
  const [followSystem, setFollowSystem] = useState(true);
  const [density, setDensity] = useState('comfortable');
  const [volume, setVolume] = useState(40);
  const [theme, setTheme] = useState('system');
  const [model, setModel] = useState('sonnet');
  const [searchedModel, setSearchedModel] = useState('');
  const [sortOrder, setSortOrder] = useState('newest');
  const [view, setView] = useState('tasks');
  const [unchosenModel, setUnchosenModel] = useState('');
  const [siteAccess, setSiteAccess] = useState('ask');
  const [groupModel, setGroupModel] = useState('sonnet');
  const [groupAccess, setGroupAccess] = useState('allow');
  const [groupNotify, setGroupNotify] = useState(true);
  const [members, setMembers] = useState(['researcher', 'writer']);
  return (
    <Section id="forms" title="Form controls">
      <div className="grid max-w-3xl grid-cols-2 gap-4">
        <TextField aria-label="Task name" placeholder="Name the task" value={name} onChange={(event) => setName(event.target.value)} />
        <TextField aria-label="API key" invalid defaultValue="sk-" />
        <TextArea aria-label="Notes" placeholder="Add notes" value={notes} onChange={(event) => setNotes(event.target.value)} />
        <div className="flex flex-col gap-2">
          <Checkbox label="Include attachments" checked={attachments} onCheckedChange={setAttachments} />
          <Switch label="Notify when done" checked={notify} onCheckedChange={setNotify} />
          <Switch label="Disabled switch" checked={false} disabled onCheckedChange={() => undefined} />
        </div>
        <RadioGroup
          label="Density"
          value={density}
          onValueChange={setDensity}
          options={[{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }, { value: 'spacious', label: 'Spacious (not available)', disabled: true }]}
        />
        <Slider label="Volume" value={volume} onValueChange={setVolume} />
        <RadioGroup
          label="Sort order"
          orientation="horizontal"
          value={sortOrder}
          onValueChange={setSortOrder}
          options={[{ value: 'newest', label: 'Newest first' }, { value: 'oldest', label: 'Oldest first' }]}
        />
        <SegmentedControl
          label="View"
          value={view}
          onValueChange={setView}
          options={[{ value: 'tasks', label: 'Tasks', icon: AppIcons.compose }, { value: 'files', label: 'Files', icon: AppIcons.folder }]}
        />
        <SegmentedControl label="Theme" value={theme} onValueChange={setTheme} options={[{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
        <Select label="Model" value={model} onValueChange={setModel} options={PREVIEW_MODELS} />
        <Select label="Model (not chosen)" value={unchosenModel} onValueChange={setUnchosenModel} placeholder="Choose a model" options={PREVIEW_MODELS} />
        <Combobox
          label="Search models"
          value={searchedModel}
          onValueChange={setSearchedModel}
          options={PREVIEW_MODELS}
          placeholder="Choose a model"
          searchPlaceholder="Filter models"
          emptyText="No matching model"
        />
        <MultiCombobox
          label="Team members"
          values={members}
          onValuesChange={setMembers}
          options={TEAM_MEMBERS}
          placeholder="Choose members"
          searchPlaceholder="Filter experts"
          emptyText="No matching expert"
        />
      </div>
      <h3 className="mt-6 mb-3 text-ui font-medium text-label-secondary">Disabled and invalid</h3>
      <div className="grid max-w-3xl grid-cols-2 gap-4">
        <TextField aria-label="Disabled field" disabled defaultValue="Read only" />
        <TextArea aria-label="Disabled notes" disabled defaultValue="Locked while the task runs" />
        <TextArea aria-label="Notes with an error" invalid defaultValue="Too short" />
        <div className="flex flex-col gap-2">
          <Checkbox label="Disabled checkbox" checked disabled onCheckedChange={() => undefined} />
          <Slider label="Disabled volume" value={60} disabled onValueChange={() => undefined} />
        </div>
        <Select label="Disabled model" value="sonnet" disabled onValueChange={() => undefined} options={PREVIEW_MODELS} />
        <Combobox
          label="Disabled model search"
          value="sonnet"
          disabled
          onValueChange={() => undefined}
          options={PREVIEW_MODELS}
          placeholder="Choose a model"
          searchPlaceholder="Filter models"
          emptyText="No matching model"
        />
      </div>
      <div className="mt-4 max-w-3xl">
        <SettingRow title="Follow system appearance" description={CJK_SPECIMEN} htmlFor="preview-follow-system">
          <Switch id="preview-follow-system" checked={followSystem} onCheckedChange={setFollowSystem} />
        </SettingRow>
      </div>
      <h3 className="mt-6 mb-3 text-ui font-medium text-label-secondary">Select with descriptions and status icons</h3>
      <Select label="Site access" value={siteAccess} onValueChange={setSiteAccess} options={SITE_ACCESS} />
      <h3 className="mt-6 mb-3 text-ui font-medium text-label-secondary">Setting group</h3>
      <div className="max-w-3xl">
        <SettingGroup title="Tasks" description="How Abu runs a task.">
          <SettingRow title="Default model" description="Used by a new task.">
            <div className="w-40">
              <Select fullWidth label="Default model" value={groupModel} onValueChange={setGroupModel} options={PREVIEW_MODELS} />
            </div>
          </SettingRow>
          <SettingRow title="Site access">
            <div className="w-40">
              <Select fullWidth label="Site access in tasks" value={groupAccess} onValueChange={setGroupAccess} options={SITE_ACCESS} />
            </div>
          </SettingRow>
          <SettingRow title="Notify when done" description="A system notification when a task ends." htmlFor="preview-group-notify">
            <Switch id="preview-group-notify" checked={groupNotify} onCheckedChange={setGroupNotify} />
          </SettingRow>
        </SettingGroup>
      </div>
    </Section>
  );
}
