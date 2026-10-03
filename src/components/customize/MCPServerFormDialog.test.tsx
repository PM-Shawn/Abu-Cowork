// @vitest-environment happy-dom
import { useState, type ReactElement } from 'react';
import { act, fireEvent, render as renderBare, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
import { getI18n } from '@/i18n';
import MCPServerFormDialog, { type MCPServerFormDialogProps, type MCPServerFormValues } from './MCPServerFormDialog';

const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });
const tb = () => getI18n().toolbox;
const ds = () => getI18n().designSystem;

const ENV_VALUE = 'mcp-env-not-a-secret';
const HEADER_VALUE = 'mcp-header-not-a-secret';
const BLANK: MCPServerFormValues = { name: '', transport: 'stdio', command: '', args: '', env: '', url: '', headers: '' };

type HostProps = Partial<Omit<MCPServerFormDialogProps, 'values'>> & { initial?: Partial<MCPServerFormValues>; initialJson?: string };

/** Owns the form's state the way the connectors page does. */
function Host({ initial, initialJson = '', onChange, onAddModeChange, onJsonInputChange, onSubmit = () => {}, onClose = () => {}, open = true, ...rest }: HostProps) {
  const [values, setValues] = useState<MCPServerFormValues>({ ...BLANK, ...initial });
  const [addMode, setAddMode] = useState<'form' | 'json'>(rest.addMode ?? 'form');
  const [jsonInput, setJsonInput] = useState(initialJson);
  return (
    <MCPServerFormDialog
      mode="add"
      editingServerName={null}
      serverNameError=""
      jsonError=""
      {...rest}
      open={open}
      values={values}
      onChange={(patch) => { onChange?.(patch); setValues((current) => ({ ...current, ...patch })); }}
      addMode={addMode}
      onAddModeChange={(next) => { onAddModeChange?.(next); setAddMode(next); }}
      jsonInput={jsonInput}
      onJsonInputChange={(next) => { onJsonInputChange?.(next); setJsonInput(next); }}
      onSubmit={onSubmit}
      onClose={onClose}
    />
  );
}

const input = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const submit = (label = tb().add) => screen.getByRole('button', { name: label }) as HTMLButtonElement;

// happy-dom reports no animation, so Radix removes a closed layer at once. With this, a closed
// layer has an exit animation: it stays on the page, as it does in the app while it fades out.
function keepClosingLayersOnScreen() {
  const real = window.getComputedStyle.bind(window);
  return vi.spyOn(window, 'getComputedStyle').mockImplementation((element: Element, pseudo?: string | null) => {
    const styles = real(element, pseudo);
    return new Proxy(styles, {
      get(target, prop) {
        if (prop === 'animationName') return element.getAttribute('data-state') === 'closed' ? 'exit' : 'enter';
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  });
}

function closingWindow(): HTMLElement {
  const closing = document.querySelector<HTMLElement>('[role="dialog"][data-state="closed"]');
  if (!closing) throw new Error('No window is closing');
  return closing;
}

// Ends the fade: the window leaves the page, and what it does once it has gone runs (one timer tick later).
function finishClosing() {
  vi.useFakeTimers();
  try {
    const ended = new Event('animationend', { bubbles: true });
    Object.defineProperty(ended, 'animationName', { value: 'exit' });
    act(() => { closingWindow().dispatchEvent(ended); });
    act(() => { vi.runOnlyPendingTimers(); });
  } finally {
    vi.useRealTimers();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MCPServerFormDialog · the window', () => {
  it('is a window named after what it does: add, or edit', () => {
    const view = render(<Host />);
    expect(screen.getByRole('dialog', { name: tb().addCustomServer })).toBeInTheDocument();
    expect(submit(tb().add)).toBeInTheDocument();
    view.unmount();

    render(<Host mode="edit" editingServerName="my-db" initial={{ name: 'my-db', command: 'psql' }} />);
    expect(screen.getByRole('dialog', { name: tb().skillEdit })).toBeInTheDocument();
    expect(submit(getI18n().common.save)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: getI18n().common.close })).toBeInTheDocument();
  });

  it('opens on the first field that takes text', async () => {
    const view = render(<Host />);
    await waitFor(() => expect(document.activeElement).toBe(input(tb().serverName)));
    view.unmount();

    // A locked name takes no text: the next field does.
    render(<Host mode="edit" editingServerName="github" initial={{ name: 'github', command: 'npx' }} nameLockedHint={tb().serverNameLockedHint} />);
    await waitFor(() => expect(document.activeElement).toBe(input(tb().serverCommand)));
  });

  it('renders nothing while it is closed', () => {
    render(<Host open={false} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('names every field with its label', () => {
    render(<Host />);
    expect(input(tb().serverName).placeholder).toBe(tb().serverName);
    expect(input(tb().serverCommand).placeholder).toBe(tb().serverCommand);
    expect(input(tb().serverArgs).placeholder).toBe(tb().serverArgs);
    expect(input('Env (JSON)').placeholder).toBe('{"API_KEY": "..."}');
    expect(screen.getByRole('group', { name: tb().transportType })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: tb().transportHttp }));
    expect(input('URL').placeholder).toBe(tb().serverUrlPlaceholder);
    expect(input('Headers (JSON)').placeholder).toBe(tb().serverHeadersPlaceholder);

    fireEvent.click(screen.getByRole('radio', { name: tb().jsonMode }));
    expect(screen.getByLabelText(tb().jsonConfigLabel, { selector: 'textarea' })).toBeInTheDocument();
    expect(screen.getByText(tb().jsonConfigHint)).toBeInTheDocument();
  });

  it('shows Env, Headers and the JSON config in the code font, as plain text fields', () => {
    render(<Host />);
    expect(input('Env (JSON)')).toHaveClass('font-code');
    expect(input('Env (JSON)').type).toBe('text');
    fireEvent.click(screen.getByRole('radio', { name: tb().transportHttp }));
    expect(input('Headers (JSON)')).toHaveClass('font-code');
    expect(input('Headers (JSON)').type).toBe('text');
    fireEvent.click(screen.getByRole('radio', { name: tb().jsonMode }));
    expect(screen.getByLabelText(tb().jsonConfigLabel, { selector: 'textarea' })).toHaveClass('font-code');
  });

  it('puts Env and Headers values nowhere but in their own fields', () => {
    render(<Host initial={{ name: 'remote', command: 'node', env: `{"TOKEN":"${ENV_VALUE}"}`, url: 'http://127.0.0.1:9/mcp', headers: `{"X-Key":"${HEADER_VALUE}"}` }} />);
    const outsideFields = (value: string) => Array.from(document.body.querySelectorAll('*')).filter((element) => {
      const isField = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
      const inAttribute = Array.from(element.attributes).some((attribute) => !(isField && attribute.name === 'value') && attribute.value.includes(value));
      const inText = !isField && Array.from(element.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.includes(value));
      return inAttribute || inText;
    });
    expect(input('Env (JSON)').value).toContain(ENV_VALUE);
    expect(outsideFields(ENV_VALUE)).toEqual([]);
    fireEvent.click(screen.getByRole('radio', { name: tb().transportHttp }));
    expect(input('Headers (JSON)').value).toContain(HEADER_VALUE);
    expect(outsideFields(HEADER_VALUE)).toEqual([]);
  });

  it('marks a refused name and says why', () => {
    const message = tb().serverNameExists.replace('{name}', 'taken');
    render(<Host initial={{ name: 'taken', command: 'node' }} serverNameError={message} />);
    expect(input(tb().serverName)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent(message);
  });

  it('shows a JSON config that was refused next to it', () => {
    render(<Host addMode="json" initialJson="{" jsonError={tb().jsonConfigInvalid} />);
    expect(screen.getByLabelText(tb().jsonConfigLabel, { selector: 'textarea' })).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent(tb().jsonConfigInvalid);
  });

  it('locks the name of a connector that keeps its identity and says why', () => {
    render(<Host mode="edit" editingServerName="github" initial={{ name: 'github', command: 'npx' }} nameLockedHint={tb().serverNameLockedHint} />);
    expect(input(tb().serverName)).toBeDisabled();
    expect(screen.getByText(tb().serverNameLockedHint)).toBeInTheDocument();
  });
});

describe('MCPServerFormDialog · the two choices and the keyboard', () => {
  // The keys go to the control: it takes the focus right before them, with no pause in between.
  async function press(target: HTMLElement, keys: string) {
    target.focus();
    await userEvent.setup({ delay: null }).keyboard(keys);
  }

  it('moves between the transports on an arrow key and chooses only on Space', async () => {
    const onChange = vi.fn();
    render(<Host onChange={onChange} />);
    const stdio = screen.getByRole('radio', { name: tb().transportStdio });
    const http = screen.getByRole('radio', { name: tb().transportHttp });
    expect(stdio).toHaveAttribute('aria-checked', 'true');

    await press(stdio, '{ArrowRight}');
    await waitFor(() => expect(document.activeElement).toBe(http));
    expect(onChange).not.toHaveBeenCalled();
    expect(stdio).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByLabelText('URL')).toBeNull();

    await press(http, ' ');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ transport: 'http' });
    expect(screen.getByRole('radio', { name: tb().transportHttp })).toHaveAttribute('aria-checked', 'true');
    expect(input('URL')).toBeInTheDocument();
  });

  it('moves between Form and JSON on an arrow key and chooses only on Space', async () => {
    const onAddModeChange = vi.fn();
    render(<Host onAddModeChange={onAddModeChange} />);
    const form = screen.getByRole('radio', { name: tb().formMode });
    const json = screen.getByRole('radio', { name: tb().jsonMode });

    await press(form, '{ArrowRight}');
    await waitFor(() => expect(document.activeElement).toBe(json));
    expect(onAddModeChange).not.toHaveBeenCalled();
    expect(input(tb().serverName)).toBeInTheDocument();

    await press(json, ' ');
    expect(onAddModeChange).toHaveBeenCalledTimes(1);
    expect(onAddModeChange).toHaveBeenCalledWith('json');
    expect(screen.queryByLabelText(tb().serverName)).toBeNull();
  });
});

describe('MCPServerFormDialog · submitting', () => {
  it('offers the submit button only once the form can be submitted', () => {
    render(<Host />);
    expect(submit()).toBeDisabled();
    fireEvent.change(input(tb().serverName), { target: { value: 'my-server' } });
    expect(submit()).toBeDisabled();
    fireEvent.change(input(tb().serverCommand), { target: { value: 'node' } });
    expect(submit()).not.toBeDisabled();
    fireEvent.change(input(tb().serverName), { target: { value: '  ' } });
    expect(submit()).toBeDisabled();
    fireEvent.change(input(tb().serverName), { target: { value: 'my-server' } });

    fireEvent.click(screen.getByRole('radio', { name: tb().transportHttp }));
    expect(submit()).toBeDisabled();
    fireEvent.change(input('URL'), { target: { value: 'http://127.0.0.1:9/mcp' } });
    expect(submit()).not.toBeDisabled();

    fireEvent.click(screen.getByRole('radio', { name: tb().jsonMode }));
    expect(submit()).toBeDisabled();
    fireEvent.change(screen.getByLabelText(tb().jsonConfigLabel, { selector: 'textarea' }), { target: { value: '{}' } });
    expect(submit()).not.toBeDisabled();
  });

  it('reports each change to its owner and nothing more', () => {
    const onChange = vi.fn();
    const onJsonInputChange = vi.fn();
    render(<Host onChange={onChange} onJsonInputChange={onJsonInputChange} />);
    fireEvent.change(input(tb().serverName), { target: { value: 'n' } });
    fireEvent.change(input(tb().serverCommand), { target: { value: 'c' } });
    fireEvent.change(input(tb().serverArgs), { target: { value: 'a' } });
    fireEvent.change(input('Env (JSON)'), { target: { value: 'e' } });
    fireEvent.click(screen.getByRole('radio', { name: tb().transportHttp }));
    fireEvent.change(input('URL'), { target: { value: 'u' } });
    fireEvent.change(input('Headers (JSON)'), { target: { value: 'h' } });
    expect(onChange.mock.calls).toEqual([
      [{ name: 'n' }], [{ command: 'c' }], [{ args: 'a' }], [{ env: 'e' }], [{ transport: 'http' }], [{ url: 'u' }], [{ headers: 'h' }],
    ]);
    fireEvent.click(screen.getByRole('radio', { name: tb().jsonMode }));
    fireEvent.change(screen.getByLabelText(tb().jsonConfigLabel, { selector: 'textarea' }), { target: { value: '{}' } });
    expect(onJsonInputChange.mock.calls).toEqual([['{}']]);
  });

  it('submits once, and takes no second press while that submit runs', async () => {
    let finish: () => void = () => {};
    const onSubmit = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(<Host initial={{ name: 'my-server', command: 'node' }} onSubmit={onSubmit} />);
    fireEvent.click(submit());
    expect(onSubmit).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(submit()).toHaveAttribute('aria-disabled', 'true'));
    expect(submit()).not.toBeDisabled();

    fireEvent.click(submit());
    expect(onSubmit).toHaveBeenCalledTimes(1);

    await act(async () => { finish(); });
    expect(submit()).not.toHaveAttribute('aria-disabled');
    fireEvent.click(submit());
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it('is ready again when it is reopened while an earlier submit is still running', async () => {
    const onSubmit = vi.fn(() => new Promise<void>(() => {}));
    const view = render(<Host initial={{ name: 'my-server', command: 'node' }} onSubmit={onSubmit} />);
    fireEvent.click(submit());
    await waitFor(() => expect(submit()).toHaveAttribute('aria-disabled', 'true'));

    view.rerender(<Host open={false} onSubmit={onSubmit} />);
    view.rerender(<Host onSubmit={onSubmit} />);
    expect(submit()).not.toHaveAttribute('aria-disabled');
    fireEvent.click(submit());
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it('keeps waiting for its own submit when one left running by an earlier opening ends', async () => {
    const finish: (() => void)[] = [];
    const onSubmit = vi.fn(() => new Promise<void>((resolve) => { finish.push(resolve); }));
    const view = render(<Host initial={{ name: 'my-server', command: 'node' }} onSubmit={onSubmit} />);
    fireEvent.click(submit());
    view.rerender(<Host open={false} onSubmit={onSubmit} />);
    view.rerender(<Host onSubmit={onSubmit} />);
    fireEvent.click(submit());
    await waitFor(() => expect(submit()).toHaveAttribute('aria-disabled', 'true'));
    expect(onSubmit).toHaveBeenCalledTimes(2);

    await act(async () => { finish[0](); });
    expect(submit()).toHaveAttribute('aria-disabled', 'true');
    await act(async () => { finish[1](); });
    expect(submit()).not.toHaveAttribute('aria-disabled');
  });

  it('keeps showing what it held while it fades out, after its owner emptied the fields', () => {
    const props = {
      editingServerName: null, onChange: () => {}, addMode: 'form' as const, onAddModeChange: () => {},
      jsonInput: '', onJsonInputChange: () => {}, serverNameError: '', jsonError: '', onSubmit: () => {}, onClose: () => {},
    };
    const view = render(<MCPServerFormDialog {...props} open mode="edit" values={{ ...BLANK, name: 'my-db', command: 'psql' }} />);
    keepClosingLayersOnScreen();
    view.rerender(<MCPServerFormDialog {...props} open={false} mode="add" values={BLANK} />);

    const closing = closingWindow();
    expect(closing).toHaveAccessibleName(tb().skillEdit);
    expect((within(closing).getByLabelText(tb().serverName) as HTMLInputElement).value).toBe('my-db');
    expect(within(closing).getByRole('button', { name: getI18n().common.save })).toBeInTheDocument();
    finishClosing();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('submits nothing from a window that is closing', () => {
    const onSubmit = vi.fn();
    const view = render(<Host initial={{ name: 'my-server', command: 'node' }} onSubmit={onSubmit} />);
    keepClosingLayersOnScreen();
    view.rerender(<Host open={false} onSubmit={onSubmit} />);

    const closing = closingWindow();
    // The window still shows what it held.
    expect((within(closing).getByLabelText(tb().serverName) as HTMLInputElement).value).toBe('my-server');
    fireEvent.click(within(closing).getByRole('button', { name: tb().add }));
    expect(onSubmit).not.toHaveBeenCalled();

    finishClosing();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('MCPServerFormDialog · closing', () => {
  it('closes on Escape, on Cancel and on the close button while nothing was typed', () => {
    const onClose = vi.fn();
    render(<Host onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: getI18n().common.cancel }));
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: getI18n().common.close }));
    expect(onClose).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it.each([
    ['a field', () => fireEvent.change(input(tb().serverName), { target: { value: 'my-server' } })],
    ['the JSON config', () => {
      fireEvent.click(screen.getByRole('radio', { name: tb().jsonMode }));
      fireEvent.change(screen.getByLabelText(tb().jsonConfigLabel, { selector: 'textarea' }), { target: { value: '{' } });
    }],
  ] as const)('asks before discarding once %s holds something typed', async (_what, typeSomething) => {
    const onClose = vi.fn();
    render(<Host onClose={onClose} />);
    typeSomething();
    fireEvent.keyDown(document, { key: 'Escape' });

    const question = await screen.findByRole('alertdialog', { name: ds().discardTitle });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(within(question).getByRole('button', { name: ds().discard }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('asks on Cancel too, and keeps the window when the answer is to keep editing', async () => {
    const onClose = vi.fn();
    render(<Host onClose={onClose} />);
    fireEvent.change(input(tb().serverName), { target: { value: 'my-server' } });
    fireEvent.click(screen.getByRole('button', { name: getI18n().common.cancel }));

    const question = await screen.findByRole('alertdialog', { name: ds().discardTitle });
    fireEvent.click(within(question).getByRole('button', { name: ds().keepEditing }));
    expect(onClose).not.toHaveBeenCalled();
    expect(input(tb().serverName).value).toBe('my-server');
  });

  it('does not ask about a switch between Form and JSON or between the transports', () => {
    const onClose = vi.fn();
    render(<Host onClose={onClose} />);
    fireEvent.click(screen.getByRole('radio', { name: tb().jsonMode }));
    fireEvent.click(screen.getByRole('radio', { name: tb().formMode }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('opens an edit with the connector it holds as the starting point', () => {
    const onClose = vi.fn();
    render(<Host mode="edit" editingServerName="my-db" initial={{ name: 'my-db', command: 'psql', env: `{"TOKEN":"${ENV_VALUE}"}` }} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('takes what its owner filled in after it opened as the starting point', () => {
    const onClose = vi.fn();
    function Prefilled() {
      const [values, setValues] = useState<MCPServerFormValues>(BLANK);
      const [startingPoint, setStartingPoint] = useState(0);
      return (
        <>
          <MCPServerFormDialog
            open mode="add" editingServerName={null} serverNameError="" jsonError=""
            values={values} onChange={(patch) => setValues((current) => ({ ...current, ...patch }))}
            addMode="form" onAddModeChange={() => {}} jsonInput="" onJsonInputChange={() => {}}
            startingPoint={startingPoint} onSubmit={() => {}} onClose={onClose}
          />
          <span data-testid="fill" onClick={() => { setValues({ ...BLANK, name: 'github', command: 'npx' }); setStartingPoint((count) => count + 1); }} />
        </>
      );
    }
    render(<Prefilled />);
    fireEvent.click(screen.getByTestId('fill'));
    expect(input(tb().serverName).value).toBe('github');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
