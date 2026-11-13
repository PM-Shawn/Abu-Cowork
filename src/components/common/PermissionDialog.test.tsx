// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { cleanup, fireEvent, render as renderBare, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PermissionDialog, { type PermissionRequest } from './PermissionDialog';
import { Button } from '@/components/ds/button';
import { Dialog } from '@/components/ds/dialog';
import { DesignSystemProvider } from '@/components/ds/provider';
import { TextField } from '@/components/ds/text-field';
import { getI18n, initLanguage } from '@/i18n';
import { passSettleInterval } from '@/test/dsWindows';

// The grant window for a path or a folder: a grant lets Abu read or write there for good (the
// default since permissions batch 1, 2026-11) or until the app is quit. These cases pin what each control answers; the stores that record a
// grant are exercised where the window is mounted (ChatView, ChatInput, WorkspaceFilesSection).
//
// The window takes no pointer press for a moment after it appears; the keyboard is never held.
// These cases are about what each control answers, so the window has been read when they begin:
// the clock it reads is past that moment once it is on the page.
const render = (ui: ReactElement) => {
  const view = renderBare(ui, { wrapper: DesignSystemProvider });
  passSettleInterval();
  return view;
};

const FILE = '/fake/project/notes.txt';
const FOLDER = '/fake/project';

function open(request: PermissionRequest) {
  const calls = { onAllow: vi.fn(), onDeny: vi.fn(), onChooseFolder: vi.fn(), onAuthorize: vi.fn() };
  const view = render(<PermissionDialog request={request} {...calls} />);
  return { ...calls, view };
}
const button = (name: string) => screen.getByRole('button', { name });
const buttonNames = () => screen.getAllByRole('button').map((element) => element.textContent).filter((name) => name !== '');
// One of the two durations.
const duration = (name: string) => screen.getByRole('radio', { name });
// The allowing button. With 「始终允许」 chosen it carries the same words as that duration.
const allow = (name: string) => screen.getByRole('button', { name });
// The corner button is the one button without words.
const cornerButton = () => {
  const found = screen.getAllByRole('button').find((candidate) => candidate.textContent === '');
  if (!found) throw new Error('The window has no corner button');
  return found;
};
const granted = (calls: ReturnType<typeof open>) => [
  ...calls.onAllow.mock.calls, ...calls.onAuthorize.mock.calls, ...calls.onChooseFolder.mock.calls,
];

describe('path and folder grants: what each control answers', () => {
  beforeEach(() => { initLanguage('zh-CN'); });
  afterEach(() => { cleanup(); initLanguage('en-US'); });

  describe('a file write grant', () => {
    const request: PermissionRequest = { type: 'file-write', path: FILE };

    it('names what is asked and the path, and answers nothing by opening or by leaving the page', () => {
      const calls = open(request);
      expect(screen.getByRole('heading', { name: '文件写入权限' })).toBeInTheDocument();
      expect(screen.getByText('阿布需要创建或修改文件')).toBeInTheDocument();
      expect(document.body.textContent?.split(FILE)).toHaveLength(2);
      expect(granted(calls)).toEqual([]);
      expect(calls.onDeny).not.toHaveBeenCalled();

      calls.view.unmount();
      expect(granted(calls)).toEqual([]);
      expect(calls.onDeny).not.toHaveBeenCalled();
    });

    it('offers a grant for good by default: one press on 「始终允许」 allows for good, once', async () => {
      const calls = open(request);
      await userEvent.setup().click(allow('始终允许'));
      expect(calls.onAllow.mock.calls).toEqual([['always']]);
      expect(calls.onDeny).not.toHaveBeenCalled();
      // No second question: the folder is asked about once and remembered.
      expect(screen.queryByText('确定始终允许？这将永久记住此授权。')).toBeNull();
    });

    it('allows until the app is quit when that is chosen', async () => {
      const user = userEvent.setup();
      const calls = open(request);
      await user.click(duration('直到关闭应用'));
      expect(calls.onAllow).not.toHaveBeenCalled();
      await user.click(allow('允许到关闭应用'));
      expect(calls.onAllow.mock.calls).toEqual([['session']]);
      expect(calls.onDeny).not.toHaveBeenCalled();
    });

    it('grants the duration chosen last', async () => {
      const user = userEvent.setup();
      const calls = open(request);
      await user.click(duration('直到关闭应用'));
      await user.click(duration('始终允许'));
      await user.click(allow('始终允许'));
      expect(calls.onAllow.mock.calls).toEqual([['always']]);
    });

    it('denies from 「拒绝」, once', async () => {
      const calls = open(request);
      await userEvent.setup().click(button('拒绝'));
      expect(calls.onDeny).toHaveBeenCalledTimes(1);
      expect(granted(calls)).toEqual([]);
    });

    it('denies from the corner button', async () => {
      const calls = open(request);
      await userEvent.setup().click(cornerButton());
      expect(calls.onDeny).toHaveBeenCalledTimes(1);
      expect(granted(calls)).toEqual([]);
    });

    it('denies once on Escape and never allows', async () => {
      const calls = open(request);
      await userEvent.setup().keyboard('{Escape}');
      expect(calls.onDeny).toHaveBeenCalledTimes(1);
      expect(granted(calls)).toEqual([]);
    });

    it('never allows on Enter or Space pressed right after it opened', async () => {
      const user = userEvent.setup();
      const calls = open(request);
      await user.keyboard('{Enter}');
      await user.keyboard(' ');
      expect(granted(calls)).toEqual([]);
    });

    it('shows the path as text and in no title, aria-label or data attribute', () => {
      open(request);
      const carriers: string[] = [];
      for (const element of Array.from(document.body.querySelectorAll('*'))) {
        for (const attribute of Array.from(element.attributes)) {
          const watched = attribute.name === 'title' || attribute.name === 'aria-label' || attribute.name.startsWith('data-');
          if (watched && attribute.value.includes('fake')) carriers.push(`${attribute.name}=${attribute.value}`);
        }
      }
      expect(carriers).toEqual([]);
    });
  });

  describe.each([
    ['a file read grant', 'file-read', 'fileRead'],
    ['a workspace grant', 'workspace', 'workspace'],
    ['a shell grant', 'shell', 'shell'],
    ['a file write grant', 'file-write', 'fileWrite'],
  ] as const)('%s', (_name, type, key) => {
    it('takes its title, its explanation, what Abu may do and its warning from the words for that kind', () => {
      open({ type, path: FOLDER });
      const words = getI18n().permission[key];
      if (!words) throw new Error(`No words for ${key}`);
      expect(screen.getByRole('heading', { name: words.title })).toBeInTheDocument();
      expect(screen.getByText(words.description)).toBeInTheDocument();
      expect(screen.getByText('阿布将可以：')).toBeInTheDocument();
      expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual(words.capabilities);
      expect(screen.getByText(words.warning)).toBeInTheDocument();
      expect(screen.getByText(FOLDER)).toBeInTheDocument();
    });

    it('allows for good from its default and denies from 「拒绝」', async () => {
      const user = userEvent.setup();
      const calls = open({ type, path: FOLDER });
      await user.click(allow('始终允许'));
      expect(calls.onAllow.mock.calls).toEqual([['always']]);
      await user.click(button('拒绝'));
      expect(calls.onDeny).toHaveBeenCalledTimes(1);
    });
  });

  it('shows no path block for a grant without a path', () => {
    open({ type: 'shell' });
    expect(screen.getByRole('heading', { name: 'Shell 命令执行权限' })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('/fake');
  });

  describe('a workspace request that names a folder', () => {
    const request: PermissionRequest = { type: 'folder-select', path: FOLDER, reason: 'needs a folder' };

    it('names the folder and offers no duration', () => {
      const calls = open(request);
      expect(screen.getByRole('heading', { name: '工作区访问权限' })).toBeInTheDocument();
      expect(screen.getByText('阿布需要访问此文件夹来帮你完成任务')).toBeInTheDocument();
      expect(screen.getByText(FOLDER)).toBeInTheDocument();
      expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual(getI18n().permission.folderSelect?.authorizeCapabilities);
      expect(screen.getByText('阿布可以读写此目录下的所有文件。请确保你信任此操作。')).toBeInTheDocument();
      expect(buttonNames()).toEqual(['拒绝', '允许访问', '选择其他文件夹']);
      expect(screen.queryByRole('radio')).toBeNull();
      expect(granted(calls)).toEqual([]);
      expect(calls.onDeny).not.toHaveBeenCalled();
    });

    it('authorizes the folder from 「允许访问」 and from nothing else', async () => {
      const calls = open(request);
      await userEvent.setup().click(button('允许访问'));
      expect(calls.onAuthorize).toHaveBeenCalledTimes(1);
      expect(calls.onChooseFolder).not.toHaveBeenCalled();
      expect(calls.onAllow).not.toHaveBeenCalled();
      expect(calls.onDeny).not.toHaveBeenCalled();
    });

    it('goes to the folder picker from 「选择其他文件夹」 without authorizing the folder it names', async () => {
      const calls = open(request);
      await userEvent.setup().click(button('选择其他文件夹'));
      expect(calls.onChooseFolder).toHaveBeenCalledTimes(1);
      expect(calls.onAuthorize).not.toHaveBeenCalled();
      expect(calls.onDeny).not.toHaveBeenCalled();
    });

    it.each([
      ['「拒绝」', async () => { await userEvent.setup().click(button('拒绝')); }],
      ['the corner button', async () => { await userEvent.setup().click(cornerButton()); }],
      ['Escape', async () => { await userEvent.setup().keyboard('{Escape}'); }],
    ] as const)('denies from %s', async (_name, act) => {
      const calls = open(request);
      await act();
      expect(calls.onDeny).toHaveBeenCalledTimes(1);
      expect(granted(calls)).toEqual([]);
    });

    it('never authorizes on Enter or Space pressed right after it opened', async () => {
      const user = userEvent.setup();
      const calls = open(request);
      await user.keyboard('{Enter}');
      await user.keyboard(' ');
      expect(calls.onAuthorize).not.toHaveBeenCalled();
      expect(calls.onAllow).not.toHaveBeenCalled();
    });
  });

  describe('a workspace request that names no folder', () => {
    const request: PermissionRequest = { type: 'folder-select', reason: 'needs a folder' };

    it('asks for a folder, with one button and no 「拒绝」', () => {
      const calls = open(request);
      expect(screen.getByRole('heading', { name: '选择工作目录' })).toBeInTheDocument();
      expect(screen.getByText('阿布需要知道在哪个文件夹里工作')).toBeInTheDocument();
      expect(screen.getByText('仅访问你选择的文件夹')).toBeInTheDocument();
      expect(buttonNames()).toEqual(['选择文件夹']);
      expect(granted(calls)).toEqual([]);
    });

    it('goes to the folder picker from 「选择文件夹」', async () => {
      const calls = open(request);
      await userEvent.setup().click(button('选择文件夹'));
      expect(calls.onChooseFolder).toHaveBeenCalledTimes(1);
      expect(calls.onAuthorize).not.toHaveBeenCalled();
      expect(calls.onAllow).not.toHaveBeenCalled();
      expect(calls.onDeny).not.toHaveBeenCalled();
    });

    it.each([
      ['the corner button', async () => { await userEvent.setup().click(cornerButton()); }],
      ['Escape', async () => { await userEvent.setup().keyboard('{Escape}'); }],
    ] as const)('denies from %s', async (_name, act) => {
      const calls = open(request);
      await act();
      expect(calls.onDeny).toHaveBeenCalledTimes(1);
      expect(granted(calls)).toEqual([]);
    });
  });
});

// The window as a design-system approval layer: where the focus starts, what the keys do, and
// what the windows around it can and cannot do to it.
describe('path and folder grants as an approval layer', () => {
  beforeEach(() => { initLanguage('zh-CN'); });
  afterEach(() => { cleanup(); initLanguage('en-US'); });

  const fileWrite: PermissionRequest = { type: 'file-write', path: FILE };
  const namedFolder: PermissionRequest = { type: 'folder-select', path: FOLDER };
  const noFolder: PermissionRequest = { type: 'folder-select' };
  const approval = (name: string) => screen.getByRole('alertdialog', { name });
  const radio = (name: string) => screen.getByRole('radio', { name });
  const checked = () => screen.getAllByRole('radio').filter((item) => item.getAttribute('aria-checked') === 'true').map((item) => item.textContent);

  it('is an alert dialog named by its title and described by its explanation, with a named close button', () => {
    open(fileWrite);
    expect(approval('文件写入权限')).toHaveAttribute('data-ds-layer');
    expect(approval('文件写入权限')).toHaveAccessibleDescription('阿布需要创建或修改文件');
    expect(button('关闭')).toBeInTheDocument();
  });

  it('describes a request that names no folder by the explanation it shows, once', () => {
    open(noFolder);
    expect(approval('选择工作目录')).toHaveAccessibleDescription('阿布需要知道在哪个文件夹里工作');
    expect(screen.getAllByText('阿布需要知道在哪个文件夹里工作')).toHaveLength(1);
    // The hint under the button is no part of the description.
    expect(screen.getByText('仅访问你选择的文件夹')).toBeInTheDocument();
  });

  it('describes a workspace request that names a folder by its explanation', () => {
    open(namedFolder);
    expect(approval('工作区访问权限')).toHaveAccessibleDescription(getI18n().permission.folderSelect?.authorizeDescription ?? 'missing');
  });

  it.each([
    ['a file write grant', fileWrite, '文件写入权限'],
    ['a file read grant', { type: 'file-read', path: FILE }, '文件读取权限'],
    ['a workspace grant', { type: 'workspace', path: FOLDER }, '工作区访问权限'],
    ['a shell grant', { type: 'shell' }, 'Shell 命令执行权限'],
    ['a workspace request that names a folder', namedFolder, '工作区访问权限'],
  ] as const)('opens with the focus on 「拒绝」: %s', (_name, request, title) => {
    open(request);
    expect(approval(title)).toBeInTheDocument();
    expect(button('拒绝')).toHaveFocus();
  });

  it.each([
    ['Enter', '{Enter}', fileWrite],
    ['Space', ' ', fileWrite],
    ['Enter', '{Enter}', namedFolder],
    ['Space', ' ', namedFolder],
  ] as const)('denies on %s pressed right after it opened', async (_name, key, request) => {
    const calls = open(request);
    await userEvent.setup().keyboard(key);
    expect(calls.onDeny).toHaveBeenCalledTimes(1);
    expect(granted(calls)).toEqual([]);
  });

  it('opens a request that names no folder on 「选择文件夹」, which only goes to the folder picker', async () => {
    const calls = open(noFolder);
    expect(approval('选择工作目录')).toBeInTheDocument();
    expect(button('选择文件夹')).toHaveFocus();

    await userEvent.setup().keyboard('{Enter}');
    expect(calls.onChooseFolder).toHaveBeenCalledTimes(1);
    expect(calls.onAuthorize).not.toHaveBeenCalled();
    expect(calls.onAllow).not.toHaveBeenCalled();
    expect(calls.onDeny).not.toHaveBeenCalled();
  });

  it.each([
    ['a file write grant', fileWrite, '文件写入权限'],
    ['a workspace request that names a folder', namedFolder, '工作区访问权限'],
    ['a workspace request that names no folder', noFolder, '选择工作目录'],
  ] as const)('does nothing on a press on the scrim or on the page behind it: %s', async (_name, request, title) => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const calls = { onAllow: vi.fn(), onDeny: vi.fn(), onChooseFolder: vi.fn(), onAuthorize: vi.fn() };
    render(
      <>
        <p>Elsewhere</p>
        <PermissionDialog request={request} {...calls} />
      </>,
    );
    await user.click(document.querySelector('.bg-scrim') as Element);
    await user.click(screen.getByText('Elsewhere'));
    expect(calls.onAllow).not.toHaveBeenCalled();
    expect(calls.onAuthorize).not.toHaveBeenCalled();
    expect(calls.onChooseFolder).not.toHaveBeenCalled();
    expect(calls.onDeny).not.toHaveBeenCalled();
    expect(approval(title)).toBeInTheDocument();
  });

  it('keeps Tab among its own controls', async () => {
    const user = userEvent.setup();
    render(
      <>
        <Button>Behind</Button>
        <PermissionDialog request={fileWrite} onAllow={vi.fn()} onDeny={vi.fn()} />
      </>,
    );
    const seen: (string | null)[] = [];
    for (let presses = 0; presses < 5; presses += 1) {
      await user.tab();
      seen.push(document.activeElement?.textContent || document.activeElement?.getAttribute('aria-label') || null);
    }
    // From 「拒绝」: the allowing button, the corner button, the chosen duration, and round again.
    expect(seen).toEqual(['始终允许', '关闭', '始终允许', '拒绝', '始终允许']);
  });

  describe('the duration', () => {
    it('is two radio buttons under the name of the choice, with the grant for good chosen', () => {
      open(fileWrite);
      const group = screen.getByRole('group', { name: '授权时效' });
      expect(Array.from(group.querySelectorAll('[role="radio"]')).map((item) => item.textContent))
        .toEqual(['始终允许', '直到关闭应用']);
      expect(screen.getByText('授权时效')).toBeInTheDocument();
      expect(checked()).toEqual(['始终允许']);
    });

    it('fills the width of the window, each duration on one line', () => {
      open(fileWrite);
      expect(screen.getByRole('group', { name: '授权时效' })).toHaveClass('w-full');
      for (const item of screen.getAllByRole('radio')) {
        expect(item).toHaveClass('flex-1');
        expect(item).toHaveClass('whitespace-nowrap');
      }
    });

    it('is not offered by a workspace request', () => {
      open(namedFolder);
      expect(screen.queryByRole('radio')).toBeNull();
      cleanup();
      open(noFolder);
      expect(screen.queryByRole('radio')).toBeNull();
    });

    it('moves only the focus on the arrow keys: the choice and what allow grants stay', async () => {
      const user = userEvent.setup();
      const calls = open(fileWrite);
      // Shift+Tab from 「拒绝」 reaches the chosen duration.
      await user.tab({ shift: true });
      expect(radio('始终允许')).toHaveFocus();

      await user.keyboard('{ArrowRight}');
      expect(radio('直到关闭应用')).toHaveFocus();
      await user.keyboard('{ArrowLeft}{End}{Home}');
      expect(radio('始终允许')).toHaveFocus();

      expect(checked()).toEqual(['始终允许']);
      expect(granted(calls)).toEqual([]);
      expect(calls.onDeny).not.toHaveBeenCalled();

      // The allowing button still grants what was chosen before the arrow keys.
      await user.click(allow('始终允许'));
      expect(calls.onAllow.mock.calls).toEqual([['always']]);
    });

    it.each([['Space', ' '], ['Enter', '{Enter}']] as const)('chooses the focused duration on %s, which grants nothing', async (_name, key) => {
      const user = userEvent.setup();
      const calls = open(fileWrite);
      await user.tab({ shift: true });
      await user.keyboard('{ArrowRight}');
      await user.keyboard(key);
      expect(checked()).toEqual(['直到关闭应用']);
      expect(allow('允许到关闭应用')).toBeInTheDocument();
      expect(granted(calls)).toEqual([]);
      expect(calls.onDeny).not.toHaveBeenCalled();

      // Pressing the chosen one again leaves it chosen.
      await user.keyboard(key);
      expect(checked()).toEqual(['直到关闭应用']);
      expect(granted(calls)).toEqual([]);
    });
  });

  describe('a grant for good', () => {
    it('takes no pointer press made while the window was still settling, and takes one made after', () => {
      const calls = { onAllow: vi.fn(), onDeny: vi.fn() };
      renderBare(<PermissionDialog request={fileWrite} {...calls} />, { wrapper: DesignSystemProvider });
      fireEvent.pointerDown(allow('始终允许'));
      fireEvent.click(allow('始终允许'), { detail: 1 });
      expect(calls.onAllow).not.toHaveBeenCalled();

      passSettleInterval();
      fireEvent.pointerDown(allow('始终允许'));
      fireEvent.click(allow('始终允许'), { detail: 1 });
      expect(calls.onAllow.mock.calls).toEqual([['always']]);
      expect(calls.onDeny).not.toHaveBeenCalled();
    });

    it('is never given by Enter or Space pressed as the window appears: the focus is on 「拒绝」', async () => {
      const user = userEvent.setup();
      const calls = open(fileWrite);
      await user.keyboard('{Enter}');
      expect(calls.onAllow).not.toHaveBeenCalled();
      expect(calls.onDeny).toHaveBeenCalledTimes(1);
    });
  });

  describe('a window per request', () => {
    it('starts again for another path: the default duration and the focus on 「拒绝」', async () => {
      const user = userEvent.setup();
      const calls = open(fileWrite);
      await user.click(radio('直到关闭应用'));
      allow('允许到关闭应用').focus();

      calls.view.rerender(<PermissionDialog request={{ type: 'file-write', path: '/fake/elsewhere/report.txt' }} {...calls} />);
      expect(screen.getByText('/fake/elsewhere/report.txt')).toBeInTheDocument();
      expect(checked()).toEqual(['始终允许']);
      expect(button('拒绝')).toHaveFocus();

      await user.keyboard('{Enter}');
      expect(calls.onAllow).not.toHaveBeenCalled();
      expect(calls.onDeny).toHaveBeenCalledTimes(1);
    });

    it('starts again for another kind of grant on the same path', async () => {
      const user = userEvent.setup();
      const calls = open({ type: 'file-read', path: FOLDER });
      await user.click(radio('直到关闭应用'));
      allow('允许到关闭应用').focus();

      calls.view.rerender(<PermissionDialog request={{ type: 'file-write', path: FOLDER }} {...calls} />);
      expect(checked()).toEqual(['始终允许']);
      expect(button('拒绝')).toHaveFocus();
      expect(granted(calls)).toEqual([]);
    });

    it('keeps its state while the same request is rendered again', async () => {
      const user = userEvent.setup();
      const calls = open(fileWrite);
      await user.click(radio('直到关闭应用'));
      calls.view.rerender(<PermissionDialog request={{ type: 'file-write', path: FILE }} {...calls} />);
      expect(checked()).toEqual(['直到关闭应用']);
    });
  });

  describe('what it shows', () => {
    it('shows a long path whole, in the code font, on as many lines as it needs', () => {
      const long = `/fake/${'a-very-long-folder-name/'.repeat(12)}notes.txt`;
      open({ type: 'file-write', path: long });
      const path = screen.getByText(long);
      expect(path).toHaveClass('font-code');
      expect(path).toHaveClass('break-all');
      expect(path).not.toHaveClass('truncate');
      expect(path).not.toHaveAttribute('title');
    });

    it.each([
      ['a file write grant', fileWrite],
      ['a workspace request that names a folder', namedFolder],
    ] as const)('marks each thing Abu may do with an icon, and warns in a status message: %s', (_name, request) => {
      open(request);
      for (const item of screen.getAllByRole('listitem')) expect(item.querySelector('svg')).not.toBeNull();
      expect(screen.getByRole('status')).toHaveClass('bg-warning-soft');
      expect(screen.getByRole('status').querySelector('svg')).not.toBeNull();
    });

    it.each([
      ['a file write grant', fileWrite, '始终允许'],
      ['a workspace request that names a folder', namedFolder, '允许访问'],
      ['a workspace request that names no folder', noFolder, '选择文件夹'],
    ] as const)('has one filled button: %s', (_name, request, name) => {
      open(request);
      const filled = screen.getAllByRole('button').filter((candidate) => candidate.classList.contains('bg-emphasis'));
      expect(filled.map((candidate) => candidate.textContent)).toEqual([name]);
    });

    it('shows the kind of grant with an icon in the header', () => {
      open(fileWrite);
      expect(approval('文件写入权限').querySelector('svg[width="20"]')).not.toBeNull();
    });
  });

  describe('the windows around it', () => {
    interface PageProps {
      first?: boolean;
      second?: boolean;
      folder?: boolean;
      search?: boolean;
      form?: boolean;
      busy?: boolean;
      dirty?: boolean;
      question?: boolean;
    }
    function harness() {
      const calls = {
        onAllow: vi.fn(), onDeny: vi.fn(), secondAllow: vi.fn(), secondDeny: vi.fn(),
        folderAuthorize: vi.fn(), folderChoose: vi.fn(), folderDeny: vi.fn(),
        onSearch: vi.fn(), onForm: vi.fn(), onQuestion: vi.fn(), formAction: vi.fn(),
      };
      function Page({ first = false, second = false, folder = false, search = false, form = false, busy = false, dirty = false, question = false }: PageProps) {
        return (
          <>
            {first && <PermissionDialog request={fileWrite} onAllow={calls.onAllow} onDeny={calls.onDeny} />}
            {second && (
              <PermissionDialog
                request={{ type: 'file-read', path: '/fake/elsewhere/report.txt' }}
                onAllow={calls.secondAllow}
                onDeny={calls.secondDeny}
              />
            )}
            {folder && (
              <PermissionDialog
                request={noFolder}
                onAllow={vi.fn()}
                onAuthorize={calls.folderAuthorize}
                onChooseFolder={calls.folderChoose}
                onDeny={calls.folderDeny}
              />
            )}
            <Dialog open={search} onOpenChange={calls.onSearch} title="Search" />
            <Dialog open={form} onOpenChange={calls.onForm} busy={busy} dirty={dirty} title="Add a service">
              <TextField aria-label="Address" defaultValue="https://example.invalid/v1" />
              <Button onClick={calls.formAction}>Check</Button>
            </Dialog>
            <Dialog open={question} onOpenChange={calls.onQuestion} role="alertdialog" title="Remove this item?" footer={<Button>Keep</Button>} />
          </>
        );
      }
      return { calls, Page };
    }
    const unanswered = (calls: ReturnType<typeof harness>['calls']) => {
      expect(calls.onAllow).not.toHaveBeenCalled();
      expect(calls.onDeny).not.toHaveBeenCalled();
      expect(calls.secondAllow).not.toHaveBeenCalled();
      expect(calls.secondDeny).not.toHaveBeenCalled();
      expect(calls.folderAuthorize).not.toHaveBeenCalled();
      expect(calls.folderChoose).not.toHaveBeenCalled();
      expect(calls.folderDeny).not.toHaveBeenCalled();
    };
    // The box of a window that is in the page, on screen or hidden.
    const box = (title: string) => Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]'))
      .find((element) => element.querySelector('h2')?.textContent === title) ?? null;

    it('turns away a window that opens while it is on screen, and is not answered by that', () => {
      const { calls, Page } = harness();
      const view = render(<Page first />);
      view.rerender(<Page first search />);

      expect(calls.onSearch.mock.calls).toEqual([[false]]);
      expect(box('Search')).toBeNull();
      expect(approval('文件写入权限')).toHaveAttribute('data-state', 'open');
      expect(button('拒绝')).toHaveFocus();
      unanswered(calls);

      view.rerender(<Page first />);
      unanswered(calls);
    });

    it('takes the place of a window with nothing to lose: that window is closed, the grant is not answered', () => {
      const { calls, Page } = harness();
      const view = render(<Page search />);
      view.rerender(<Page search first />);

      expect(calls.onSearch.mock.calls).toEqual([[false]]);
      expect(approval('文件写入权限')).toBeInTheDocument();
      expect(button('拒绝')).toHaveFocus();
      unanswered(calls);
    });

    it('keeps a second grant off the page until the first is answered; neither answers the other', () => {
      const { calls, Page } = harness();
      const view = render(<Page first />);
      view.rerender(<Page first second />);

      expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
      expect(box('文件读取权限')).toBeNull();
      expect(screen.queryByText('/fake/elsewhere/report.txt')).toBeNull();
      unanswered(calls);

      // The first is answered: its owner takes it off the page.
      view.rerender(<Page second />);
      expect(approval('文件读取权限')).toBeInTheDocument();
      expect(button('拒绝')).toHaveFocus();
      unanswered(calls);
    });

    it('answers only the grant on screen when Escape is pressed with a second one waiting', async () => {
      const { calls, Page } = harness();
      render(<Page first second />);
      await userEvent.setup().keyboard('{Escape}');
      expect(calls.onDeny).toHaveBeenCalledTimes(1);
      expect(calls.onAllow).not.toHaveBeenCalled();
      expect(calls.secondAllow).not.toHaveBeenCalled();
      expect(calls.secondDeny).not.toHaveBeenCalled();
    });

    it('puts a workspace request ahead of the grants that wait, and never in the place of the one on screen', () => {
      const { calls, Page } = harness();
      const view = render(<Page first />);
      view.rerender(<Page first second />);
      view.rerender(<Page first second folder />);
      expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
      expect(approval('文件写入权限')).toBeInTheDocument();
      unanswered(calls);

      view.rerender(<Page second folder />);
      expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
      expect(approval('选择工作目录')).toBeInTheDocument();
      expect(box('文件读取权限')).toBeNull();
      unanswered(calls);

      view.rerender(<Page second />);
      expect(approval('文件读取权限')).toBeInTheDocument();
      unanswered(calls);
    });

    it('keeps a file grant that arrives later behind a workspace request that waits: a file grant has no time limit', () => {
      const { calls, Page } = harness();
      const view = render(<Page first />);
      view.rerender(<Page first folder />);
      view.rerender(<Page first folder second />);
      expect(approval('文件写入权限')).toBeInTheDocument();

      view.rerender(<Page folder second />);
      expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
      expect(approval('选择工作目录')).toBeInTheDocument();
      unanswered(calls);
    });

    it('waits, off the page and unanswered, while the user is asked about unsaved input; Discard shows it', async () => {
      const user = userEvent.setup();
      const { calls, Page } = harness();
      const view = render(<Page form dirty />);
      view.rerender(<Page form dirty first />);

      expect(screen.getByRole('alertdialog', { name: '放弃这些内容？' })).toBeInTheDocument();
      expect(box('文件写入权限')).toBeNull();
      unanswered(calls);
      expect(calls.onForm).not.toHaveBeenCalled();

      // The question about the unsaved input has been read.
      passSettleInterval();
      await user.click(button('放弃'));
      expect(calls.onForm.mock.calls).toEqual([[false]]);
      expect(approval('文件写入权限')).toBeInTheDocument();
      unanswered(calls);
    });

    it('goes on waiting, unanswered, when the user keeps the unsaved input, and is shown once that window has closed', async () => {
      const user = userEvent.setup();
      const { calls, Page } = harness();
      const view = render(<Page form dirty />);
      view.rerender(<Page form dirty first />);
      passSettleInterval();
      await user.click(button('继续填写'));

      expect(box('文件写入权限')).toBeNull();
      expect(calls.onForm).not.toHaveBeenCalled();
      unanswered(calls);

      view.rerender(<Page first />);
      expect(approval('文件写入权限')).toBeInTheDocument();
      unanswered(calls);
    });

    it('has a window with work in progress step aside, untouched, and return when the grant is answered', async () => {
      const user = userEvent.setup();
      const { calls, Page } = harness();
      const view = render(<Page form busy dirty />);
      const form = box('Add a service');
      view.rerender(<Page form busy dirty first />);

      expect(box('Add a service')).toBe(form);
      expect(form).toHaveAttribute('hidden');
      expect(screen.queryByRole('alertdialog', { name: '放弃这些内容？' })).toBeNull();
      expect(approval('文件写入权限')).toBeInTheDocument();
      expect(button('拒绝')).toHaveFocus();
      expect(calls.onForm).not.toHaveBeenCalled();
      unanswered(calls);

      // The keyboard acts on the grant alone while the window is hidden.
      await user.keyboard('{Enter}');
      expect(calls.formAction).not.toHaveBeenCalled();
      expect(calls.onForm).not.toHaveBeenCalled();
      expect(calls.onDeny).toHaveBeenCalledTimes(1);
      expect(calls.onAllow).not.toHaveBeenCalled();

      view.rerender(<Page form busy dirty />);
      expect(box('Add a service')).toBe(form);
      expect(form).not.toHaveAttribute('hidden');
      expect(screen.getByRole('textbox', { name: 'Address' })).toHaveValue('https://example.invalid/v1');
      expect(calls.onForm).not.toHaveBeenCalled();
    });

    it('is not answered by a question that is asked over it and answered', async () => {
      const { calls, Page } = harness();
      const view = render(<Page first />);
      view.rerender(<Page first question />);
      // The question is the top layer; the grant stays open under it.
      expect(screen.getByRole('alertdialog', { name: 'Remove this item?' })).toBeInTheDocument();
      expect(box('文件写入权限')).toHaveAttribute('data-state', 'open');

      await userEvent.setup().keyboard('{Escape}');
      expect(calls.onQuestion.mock.calls).toEqual([[false]]);
      unanswered(calls);

      view.rerender(<Page first />);
      unanswered(calls);
      expect(approval('文件写入权限')).toBeInTheDocument();
    });

    it('has an open question step aside, unanswered, and return', () => {
      const { calls, Page } = harness();
      const view = render(<Page question />);
      const asked = box('Remove this item?');
      view.rerender(<Page question first />);

      expect(asked).toHaveAttribute('hidden');
      expect(calls.onQuestion).not.toHaveBeenCalled();
      expect(approval('文件写入权限')).toBeInTheDocument();
      unanswered(calls);

      view.rerender(<Page question />);
      expect(asked).not.toHaveAttribute('hidden');
      expect(calls.onQuestion).not.toHaveBeenCalled();
    });
  });
});
