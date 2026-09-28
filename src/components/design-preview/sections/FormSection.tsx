import { useState } from 'react';
import { Checkbox } from '@/components/ds/checkbox';
import { Combobox } from '@/components/ds/combobox';
import { AppIcons } from '@/components/ds/icons';
import { RadioGroup } from '@/components/ds/radio-group';
import { SegmentedControl } from '@/components/ds/segmented-control';
import { Select } from '@/components/ds/select';
import { SettingRow } from '@/components/ds/setting-row';
import { Slider } from '@/components/ds/slider';
import { Switch } from '@/components/ds/switch';
import { TextArea } from '@/components/ds/text-area';
import { TextField } from '@/components/ds/text-field';
import { Section } from './Section';
import { CJK_SPECIMEN, PREVIEW_MODELS } from './specimen';

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
    </Section>
  );
}
