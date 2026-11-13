// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CommandConfirmDialog, { type CommandConfirmRequest } from './CommandConfirmDialog';
import { DesignSystemProvider } from '@/components/ds/provider';
import { initLanguage } from '@/i18n';
import { passSettleInterval } from '@/test/dsWindows';

// The approval window for a command, read by someone who cannot read the command: the system's
// own risk wording must stay in front of the model's one-line purpose, and the keyboard and
// settling rules of AGENTS.md section 6.1 must hold with the new details toggle in the box.
const COMMAND = "cd /var/tmp/case && python3 convert.py '合同.pdf'";

const request = (overrides: Partial<CommandConfirmRequest> = {}): CommandConfirmRequest => (
  { command: COMMAND, level: 'warn', reason: '这个命令会改动文件', kind: 'command', purpose: '把合同转成图片', ...overrides }
);

function open(req: CommandConfirmRequest, { settled = true }: { settled?: boolean } = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const view = render(<CommandConfirmDialog request={req} onConfirm={onConfirm} onCancel={onCancel} />, { wrapper: DesignSystemProvider });
  if (settled) passSettleInterval();
  return { onConfirm, onCancel, view };
}
const toggle = () => screen.getByRole('button', { name: '技术细节' });
const commandCode = () => screen.queryByText((_, element) => element?.tagName === 'CODE' && element.textContent === COMMAND);

describe('command approval in plain words: what the purpose may say', () => {
  beforeEach(() => { initLanguage('zh-CN'); });
  afterEach(() => { cleanup(); initLanguage('zh-CN'); });

  it.each([
    ['a Chinese phrase naming a script', '运行 python 脚本', true],
    ['an emoji', '把报告做成 PPT 🎉', true],
    ['a web address', '下载 https://example.com/a.pdf 里的报价', true],
    ['markdown', '**合并** 三个表格', true],
    ['a path with Chinese folders', '把 /Users/张三/文档/合同.pdf 转成图片', false],
    ['a Windows path', '读取 C:\\Users\\张三\\合同.docx', false],
  ])('purpose with %s: %s', (_name, purpose, shown) => {
    open(request({ purpose }));
    expect(screen.queryByRole('button', { name: '技术细节' }) !== null).toBe(shown);
    // An ordinary approval takes the purpose as its headline.
    if (shown) expect(screen.getByRole('heading', { name: purpose })).toBeInTheDocument();
    // Without a usable purpose the command is the only explanation, so it is on the page.
    if (!shown) expect(commandCode()).not.toBeNull();
  });

  // Regression: see commandPurpose.edge.test.ts. The same filter runs here, so a path
  // glued to Chinese text is shown as the headline of the approval.
  it('treats a path glued to Chinese text as no purpose', () => {
    open(request({ purpose: '保存到/tmp/work/out.pdf' }));
    expect(screen.queryByRole('button', { name: '技术细节' })).toBeNull();
  });

  // Regression: a zero-width-only purpose passes the filter, so the headline is blank
  // and the command stays hidden behind the toggle. See commandPurpose.edge.test.ts.
  it('treats an invisible-only purpose as none and shows the command', () => {
    open(request({ purpose: '\u200b\u200b' }));
    expect(screen.queryByRole('button', { name: '技术细节' })).toBeNull();
    expect(commandCode()).not.toBeNull();
  });

  it('renders markup as text', () => {
    const { view } = open(request({ purpose: '<b>合并</b><img src=x onerror=alert(1)>' }));
    expect(view.container.ownerDocument.querySelector('img')).toBeNull();
    expect(screen.getByRole('alertdialog').textContent).toContain('<b>合并</b>');
  });

  it('cuts a 200-character purpose to 60 characters', () => {
    open(request({ purpose: '合并报表'.repeat(50) }));
    const text = screen.getByRole('heading').textContent!;
    expect(Array.from(text)).toHaveLength(60);
  });

  it('shows the full command, scrollable, however long it is', () => {
    const long = `echo ${'a'.repeat(5000)}`;
    open(request({ command: long, purpose: '打印一行字' }));
    fireEvent.click(toggle());
    expect(screen.getByText(long, { selector: 'code' })).toBeInTheDocument();
  });

  it('reads the English wording in the English interface, with the English risk reason intact', () => {
    initLanguage('en-US');
    open(request({ purpose: 'Convert the contract to images', level: 'danger', reason: 'This deletes files' }));
    expect(screen.getByRole('alertdialog', { name: 'Dangerous Action' })).toBeInTheDocument();
    expect(screen.getByText('This deletes files')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Technical details' })).toHaveAttribute('aria-expanded', 'true');
  });
});

describe('command approval in plain words: a reassuring purpose on a dangerous command', () => {
  beforeEach(() => { initLanguage('zh-CN'); });
  afterEach(() => { cleanup(); initLanguage('zh-CN'); });

  const dangerous = () => request({ command: 'rm -rf ~/Documents', level: 'danger', reason: '会删除整个文件夹，无法恢复', purpose: '整理一下桌面文件' });

  it('keeps the danger title and the system reason, and opens the exact command', () => {
    open(dangerous());
    expect(screen.getByRole('alertdialog', { name: '危险操作确认' })).toBeInTheDocument();
    expect(screen.getByText('会删除整个文件夹，无法恢复')).toBeInTheDocument();
    expect(toggle()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('rm -rf ~/Documents', { selector: 'code' })).toBeInTheDocument();
  });

  it('labels the purpose as the AI\'s own statement', () => {
    open(dangerous());
    expect(screen.getByRole('alertdialog')).toHaveTextContent('AI 自述');
  });

  // Regression: with a purpose, the line under the title is the model's sentence and
  // the system's 「以下命令可能造成数据丢失或系统变更」 line is dropped. The system reason sits at the
  // bottom of the box, below the command. A person reads 「整理一下桌面文件」 first and the danger
  // wording last. The title and icon still say danger, so this is a should-fix, not a blocker.
  it('shows the system risk line before the model purpose line', () => {
    open(dangerous());
    const reason = screen.getByText('会删除整个文件夹，无法恢复');
    const purposeLine = screen.getByText(/AI 自述/);
    expect(reason.compareDocumentPosition(purposeLine) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The system's own line for the level is still the dialog's description, and comes first.
    expect(screen.getByRole('alertdialog')).toHaveAccessibleDescription('以下命令可能造成数据丢失或系统变更：');
  });

  it('a blocked command offers no confirm button even with a purpose, and shows the command', () => {
    open(request({ level: 'block', reason: '这个命令被禁止', purpose: '清理一下' }));
    expect(screen.queryByRole('button', { name: '确认执行' })).toBeNull();
    expect(commandCode()).not.toBeNull();
    expect(screen.getByRole('alertdialog', { name: '操作已阻止' })).toBeInTheDocument();
  });
});

describe('command approval in plain words: successive approvals', () => {
  beforeEach(() => { initLanguage('zh-CN'); });
  afterEach(() => { cleanup(); });

  it('shows each request its own purpose when two identical commands arrive one after the other', () => {
    const first = request({ purpose: '第一步：转成图片' });
    const second = request({ purpose: '第二步：转成图片' });
    const onConfirm = vi.fn();
    const view = render(<CommandConfirmDialog key="a" request={first} onConfirm={onConfirm} onCancel={vi.fn()} />, { wrapper: DesignSystemProvider });
    expect(screen.getByRole('alertdialog')).toHaveTextContent('第一步');
    view.rerender(<CommandConfirmDialog key="b" request={second} onConfirm={onConfirm} onCancel={vi.fn()} />);
    expect(screen.getByRole('alertdialog')).toHaveTextContent('第二步');
    expect(screen.getByRole('alertdialog')).not.toHaveTextContent('第一步');
  });

  it('a request that follows with the details open starts closed again when it is a new window', () => {
    const view = render(<CommandConfirmDialog key="a" request={request()} onConfirm={vi.fn()} onCancel={vi.fn()} />, { wrapper: DesignSystemProvider });
    passSettleInterval();
    fireEvent.click(toggle());
    expect(toggle()).toHaveAttribute('aria-expanded', 'true');
    view.rerender(<CommandConfirmDialog key="b" request={request()} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('command approval in plain words: keyboard, held keys and settling', () => {
  beforeEach(() => { initLanguage('zh-CN'); });
  afterEach(() => { cleanup(); });

  it('walks the box in the order cancel, close corner or details, confirm, and wraps without leaving it', async () => {
    const user = userEvent.setup();
    open(request());
    const seen: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      const el = document.activeElement as HTMLElement;
      seen.push(el.getAttribute('aria-label') ?? el.textContent ?? '');
      await user.tab();
    }
    const dialog = screen.getByRole('alertdialog');
    expect(seen[0]).toBe('取消');
    expect(seen).toEqual(expect.arrayContaining(['取消', '技术细节', '确认执行']));
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('Shift+Tab from cancel reaches the last control, not the page', async () => {
    const user = userEvent.setup();
    open(request());
    await user.tab({ shift: true });
    expect(screen.getByRole('alertdialog').contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(screen.getByRole('button', { name: '取消' }));
  });

  it('Space on the toggle opens it and Enter closes it, without answering the approval', async () => {
    const user = userEvent.setup();
    const { onConfirm, onCancel } = open(request());
    toggle().focus();
    await user.keyboard(' ');
    expect(toggle()).toHaveAttribute('aria-expanded', 'true');
    await user.keyboard('{Enter}');
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('a held Space on the toggle changes it once', () => {
    open(request());
    toggle().focus();
    expect(fireEvent.keyDown(toggle(), { key: ' ', code: 'Space' })).toBe(true);
    expect(fireEvent.keyDown(toggle(), { key: ' ', code: 'Space', repeat: true })).toBe(false);
  });

  it('a held Enter on cancel is dropped and answers nothing', () => {
    const { onCancel } = open(request());
    const cancel = screen.getByRole('button', { name: '取消' });
    expect(fireEvent.keyDown(cancel, { key: 'Enter', code: 'Enter', repeat: true })).toBe(false);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('a held Escape does not cancel; a fresh Escape cancels once, also with the details open', async () => {
    const user = userEvent.setup();
    const { onCancel } = open(request({ level: 'danger' }));
    const dialog = screen.getByRole('alertdialog');
    fireEvent.keyDown(dialog, { key: 'Escape', code: 'Escape', repeat: true });
    expect(onCancel).not.toHaveBeenCalled();
    toggle().focus();
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('a press outside the box answers nothing', async () => {
    const { onCancel, onConfirm } = open(request());
    fireEvent.pointerDown(document.body, { pointerType: 'mouse' });
    fireEvent.mouseDown(document.body, { detail: 1 });
    fireEvent.click(document.body, { detail: 1 });
    expect(onCancel).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  describe('settling', () => {
    beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame'] }); });
    afterEach(() => { vi.useRealTimers(); });

    it('an early pointer press on the toggle or on confirm does nothing; the keyboard is not held', () => {
      const { onConfirm } = open(request(), { settled: false });
      // fireEvent.click has detail 0 (a key press), so build a real pointer click.
      const pointerClick = (el: HTMLElement) => {
        fireEvent.pointerDown(el, { pointerType: 'mouse' });
        fireEvent.mouseDown(el, { detail: 1 });
        fireEvent.pointerUp(el, { pointerType: 'mouse' });
        fireEvent.mouseUp(el, { detail: 1 });
        fireEvent.click(el, { detail: 1 });
      };
      pointerClick(toggle());
      pointerClick(screen.getByRole('button', { name: '确认执行' }));
      expect(toggle()).toHaveAttribute('aria-expanded', 'false');
      expect(onConfirm).not.toHaveBeenCalled();
      // The same control answers a key press at once.
      toggle().focus();
      fireEvent.click(toggle());
      expect(toggle()).toHaveAttribute('aria-expanded', 'true');
      passSettleInterval();
      pointerClick(screen.getByRole('button', { name: '确认执行' }));
      expect(onConfirm).toHaveBeenCalledTimes(1);
    });

    it('carries data-ds-settling while the box holds presses back and not after', () => {
      open(request(), { settled: false });
      expect(document.querySelector('[data-ds-settling]')).not.toBeNull();
      passSettleInterval();
      expect(document.querySelector('[data-ds-settling]')).toBeNull();
    });
  });
});
