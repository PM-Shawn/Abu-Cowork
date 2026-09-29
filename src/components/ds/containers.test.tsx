// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Card } from './card';
import { Disclosure } from './disclosure';
import { AppIcons } from './icons';
import { NavItem } from './nav-item';
import { ScrollArea } from './scroll-area';
import { Steps } from './steps';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './table';
import { Tab, TabList, TabPanel, Tabs } from './tabs';

describe('containers and navigation', () => {
  it('Card is an opaque surface with panel corners', () => {
    render(<Card>Summary</Card>);
    expect(screen.getByText('Summary')).toHaveClass('bg-surface', 'rounded-panel', 'shadow-panel');
  });

  it('NavItem marks the selected row and runs its handler', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<><NavItem icon={AppIcons.folder} label="Files" selected /><NavItem label="Settings" onClick={onClick} /></>);
    expect(screen.getByRole('button', { name: 'Files' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'Files' })).toHaveClass('bg-fill-selected');
    expect(screen.getByRole('button', { name: 'Settings' })).not.toHaveAttribute('aria-current');
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('Tabs switch panels with the arrow keys', async () => {
    const user = userEvent.setup();
    render(
      <Tabs defaultValue="summary">
        <TabList label="Task panels"><Tab value="summary">Summary</Tab><Tab value="files">Files</Tab></TabList>
        <TabPanel value="summary">Summary panel</TabPanel>
        <TabPanel value="files">Files panel</TabPanel>
      </Tabs>,
    );
    screen.getByRole('tab', { name: 'Summary' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Files' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Files panel');
  });

  it('Disclosure shows and hides its content', async () => {
    const user = userEvent.setup();
    render(<Disclosure title="Steps">Step list</Disclosure>);
    const trigger = screen.getByRole('button', { name: 'Steps' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Step list')).toBeInTheDocument();
  });

  it('ScrollArea renders its content', () => {
    render(<ScrollArea className="h-16"><p>Long list</p></ScrollArea>);
    expect(screen.getByText('Long list')).toBeInTheDocument();
  });

  it('ScrollArea keeps its content at the viewport width so long text can truncate', () => {
    const { container } = render(<ScrollArea className="h-16"><p>Long list</p></ScrollArea>);
    const viewport = container.querySelector('[data-radix-scroll-area-viewport]');
    // Radix puts `display: table` on the content box; the class overrides it with block.
    expect(viewport).toHaveClass('[&>div]:!block');
    expect(viewport?.firstElementChild).toHaveStyle({ display: 'table' });
  });

  it('Table has column headers and aligned cells', () => {
    render(
      <Table label="Usage">
        <TableHeader><TableRow><TableHead>Model</TableHead><TableHead align="right">Tokens</TableHead></TableRow></TableHeader>
        <TableBody><TableRow><TableCell>Opus</TableCell><TableCell align="right">55.8k</TableCell></TableRow></TableBody>
      </Table>,
    );
    expect(screen.getByRole('table', { name: 'Usage' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Tokens' })).toHaveClass('text-right');
    expect(screen.getByRole('cell', { name: '55.8k' })).toHaveClass('text-right');
  });

  it('Steps marks the current step and names finished and failed steps', () => {
    render(
      <Steps
        label="Progress"
        steps={[
          { title: 'Read files', status: 'done', statusLabel: 'Done' },
          { title: 'Write summary', status: 'current' },
          { title: 'Upload', status: 'error', statusLabel: 'Failed' },
          { title: 'Notify', status: 'pending' },
        ]}
      />,
    );
    const items = screen.getAllByRole('listitem');
    expect(items[1]).toHaveAttribute('aria-current', 'step');
    expect(screen.getByRole('img', { name: 'Done' })).toHaveClass('text-success');
    expect(screen.getByRole('img', { name: 'Failed' })).toHaveClass('text-danger');
  });
});
