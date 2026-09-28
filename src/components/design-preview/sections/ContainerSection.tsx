import { useState } from 'react';
import { Card } from '@/components/ds/card';
import { Disclosure } from '@/components/ds/disclosure';
import { AppIcons } from '@/components/ds/icons';
import { NavItem } from '@/components/ds/nav-item';
import { ScrollArea } from '@/components/ds/scroll-area';
import { Steps, type Step } from '@/components/ds/steps';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ds/table';
import { Tab, TabList, TabPanel, Tabs } from '@/components/ds/tabs';
import { Section } from './Section';

const NAV = [
  { id: 'tasks', label: 'Tasks', icon: AppIcons.compose, count: 12 },
  { id: 'files', label: 'Files', icon: AppIcons.folder, count: undefined },
  { id: 'settings', label: 'Settings', icon: AppIcons.settings, count: undefined },
];
const STEPS: Step[] = [
  { title: 'Read 9 files', status: 'done', statusLabel: 'Done' },
  { title: 'Write the summary', description: 'About 1 minute left', status: 'current' },
  { title: 'Upload to the shared folder', status: 'error', statusLabel: 'Failed' },
  { title: 'Notify the team', status: 'pending' },
];
const FILES = Array.from({ length: 12 }, (_, index) => `report-${index + 1}.md`);
const USAGE = [['Claude Opus 5', '55.8k'], ['Claude Sonnet 5', '12.1k'], ['DeepSeek V4 Pro', '3.4k']];

export function ContainerSection() {
  const [selected, setSelected] = useState('tasks');
  return (
    <Section id="containers" title="Containers and navigation">
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <div className="flex flex-col gap-1">
            {NAV.map((item) => (
              <NavItem key={item.id} icon={item.icon} label={item.label} trailing={item.count} selected={selected === item.id} onClick={() => setSelected(item.id)} />
            ))}
          </div>
        </Card>
        <Card>
          <Tabs defaultValue="summary">
            <TabList label="Task panels">
              <Tab value="summary">Summary</Tab>
              <Tab value="files">Files</Tab>
            </TabList>
            <TabPanel value="summary">
              <Disclosure title="Steps" defaultOpen><Steps label="Progress" steps={STEPS} /></Disclosure>
            </TabPanel>
            <TabPanel value="files">
              <ScrollArea className="h-32">
                {FILES.map((file) => <p key={file} className="py-1 text-ui text-label">{file}</p>)}
              </ScrollArea>
            </TabPanel>
          </Tabs>
        </Card>
        <Card>
          <Table label="Usage">
            <TableHeader><TableRow><TableHead>Model</TableHead><TableHead align="right">Tokens</TableHead></TableRow></TableHeader>
            <TableBody>
              {USAGE.map(([model, tokens]) => (
                <TableRow key={model}><TableCell>{model}</TableCell><TableCell align="right">{tokens}</TableCell></TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </div>
    </Section>
  );
}
