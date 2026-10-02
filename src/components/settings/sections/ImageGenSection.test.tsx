// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
import { VOLCENGINE_IMAGE_BASE_URL } from '@/core/llm/imageGen';
import { format, getI18n, initLanguage } from '@/i18n';
import { useSettingsStore } from '@/stores/settingsStore';
import type { ImageGenBackend } from '@/types/provider';
import { ImageGenBackendModal, ImageGenBackendsPanel } from './ImageGenSection';

const FAKE_KEY = 'sk-test-not-a-secret';
const RECORDED = ['addImageGenBackend', 'updateImageGenBackend', 'removeImageGenBackend', 'setDefaultImageBackend'] as const;
const originals = useSettingsStore.getState();
const log: unknown[][] = [];
const t = () => getI18n();

const SEEDREAM: ImageGenBackend = {
  id: 'backend-a',
  name: 'Seedream',
  vendor: 'volcengine',
  baseUrl: 'https://images.example.test/api/v3',
  apiKey: FAKE_KEY,
  model: 'seedream-test',
};
const DALLE: ImageGenBackend = {
  id: 'backend-b',
  name: 'Dall-E',
  vendor: 'openai',
  baseUrl: 'https://images.example.test/v1',
  apiKey: '',
  model: '',
};

const field = (placeholder: string) => screen.getByPlaceholderText(placeholder) as HTMLInputElement;
const nameField = () => field(t().settings.imageGenBackendNamePlaceholder);
const addressField = () => field(t().settings.imageGenBaseUrlPlaceholder);
const keyField = () => field(t().settings.imageGenApiKeyPlaceholder);
const modelField = () => field(t().settings.imageGenModelPlaceholder);
const saveButton = () => screen.getByRole('button', { name: t().common.save });
const type = (input: HTMLInputElement, value: string) => fireEvent.change(input, { target: { value } });

// The button that shows or hides the key.
function revealButton(): HTMLElement {
  return screen.getByRole('button', { name: /^(Show key|Hide key)$/ });
}

async function chooseVendor(user: ReturnType<typeof userEvent.setup>, current: string, next: string) {
  const select = screen.getByRole('combobox', { name: t().settings.imageGenVendor });
  expect(select).toHaveTextContent(current);
  await user.click(select);
  await user.click(screen.getByRole('option', { name: next }));
}

// One of the actions on a backend row.
function rowAction(name: string, index = 0): HTMLElement {
  return screen.getAllByRole('button', { name })[index];
}

function renderModal(editBackend?: ImageGenBackend) {
  const onClose = vi.fn();
  const view = render(<ImageGenBackendModal open onClose={onClose} editBackend={editBackend} />, { wrapper: DesignSystemProvider });
  return { ...view, onClose };
}

const discardQuestion = () => screen.queryByRole('alertdialog', { name: t().designSystem.discardTitle });

function renderPanel(backends: ImageGenBackend[], defaultId?: string) {
  useSettingsStore.setState({ imageGeneration: { backends, defaultId } });
  log.length = 0;
  const onEdit = vi.fn();
  render(<ImageGenBackendsPanel onEdit={onEdit} />, { wrapper: DesignSystemProvider });
  return { onEdit };
}

beforeAll(() => {
  // happy-dom lacks the pointer-capture and scroll calls Radix Select makes while opening.
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => undefined;
  Element.prototype.releasePointerCapture ??= () => undefined;
  Element.prototype.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
  initLanguage('en-US');
  log.length = 0;
  const recorded = Object.fromEntries(RECORDED.map((name) => [name, (...args: unknown[]) => {
    log.push([name, ...args]);
    return (originals[name] as (...values: unknown[]) => unknown)(...args);
  }]));
  useSettingsStore.setState({ ...recorded, imageGeneration: { backends: [] } });
});

afterEach(() => {
  cleanup();
  useSettingsStore.setState(originals, true);
});

describe('ImageGenBackendModal', () => {
  it('saves a new backend only once name, address and model are filled in', async () => {
    const user = userEvent.setup();
    const { onClose } = renderModal();

    expect(screen.getByText(t().settings.imageGenAddBackend)).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();

    type(nameField(), 'Seedream');
    expect(saveButton()).toBeDisabled();
    type(addressField(), 'https://images.example.test/api/v3');
    expect(saveButton()).toBeDisabled();
    type(keyField(), FAKE_KEY);
    expect(saveButton()).toBeDisabled();
    type(modelField(), 'seedream-test');
    expect(saveButton()).toBeEnabled();

    type(nameField(), '   ');
    expect(saveButton()).toBeDisabled();
    type(nameField(), 'Seedream');

    expect(log).toEqual([]);
    await user.click(saveButton());

    expect(log).toEqual([['addImageGenBackend', {
      name: 'Seedream',
      vendor: 'custom',
      baseUrl: 'https://images.example.test/api/v3',
      apiKey: FAKE_KEY,
      model: 'seedream-test',
    }]]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('saves the chosen vendor with the backend', async () => {
    const user = userEvent.setup();
    renderModal();
    type(nameField(), 'Seedream');
    type(addressField(), 'https://images.example.test/api/v3');
    type(modelField(), 'seedream-test');

    await chooseVendor(user, t().settings.imageGenVendorAuto, t().settings.imageGenVendorZhipu);
    await user.click(saveButton());

    expect(log).toEqual([['addImageGenBackend', {
      name: 'Seedream',
      vendor: 'zhipu',
      baseUrl: 'https://images.example.test/api/v3',
      apiKey: '',
      model: 'seedream-test',
    }]]);
  });

  it('opens an existing backend filled in and saves the changes to that backend', async () => {
    const user = userEvent.setup();
    const { onClose } = renderModal(SEEDREAM);

    expect(screen.getByText(t().settings.imageGenEditBackend)).toBeInTheDocument();
    expect(nameField().value).toBe('Seedream');
    expect(addressField().value).toBe('https://images.example.test/api/v3');
    expect(keyField().value).toBe(FAKE_KEY);
    expect(modelField().value).toBe('seedream-test');
    expect(saveButton()).toBeEnabled();

    type(modelField(), 'seedream-next');
    await user.click(saveButton());

    expect(log).toEqual([['updateImageGenBackend', 'backend-a', {
      name: 'Seedream',
      vendor: 'volcengine',
      baseUrl: 'https://images.example.test/api/v3',
      apiKey: FAKE_KEY,
      model: 'seedream-next',
    }]]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('hides the key until the user asks to see it, and never writes it as text', async () => {
    const user = userEvent.setup();
    renderModal(SEEDREAM);

    expect(keyField()).toHaveAttribute('type', 'password');
    expect(document.body.textContent).not.toContain(FAKE_KEY);

    await user.click(revealButton());
    expect(keyField()).toHaveAttribute('type', 'text');

    await user.click(revealButton());
    expect(keyField()).toHaveAttribute('type', 'password');
  });

  it('warns about a chat address without blocking the save, and stops once the address is corrected', () => {
    renderModal();
    const warning = format(t().settings.imageGenChatEndpointWarning, { url: VOLCENGINE_IMAGE_BASE_URL });
    type(nameField(), 'Seedream');
    type(modelField(), 'seedream-test');
    expect(screen.queryByText(warning)).not.toBeInTheDocument();

    type(addressField(), 'https://ark.cn-beijing.volces.com/api/coding/v3');

    expect(screen.getByText(warning)).toBeInTheDocument();
    expect(saveButton()).toBeEnabled();

    type(addressField(), VOLCENGINE_IMAGE_BASE_URL);

    expect(screen.queryByText(warning)).not.toBeInTheDocument();
  });

  it('closes on Cancel without saving anything', async () => {
    const user = userEvent.setup();
    const { onClose } = renderModal();

    await user.click(screen.getByRole('button', { name: t().common.cancel }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(log).toEqual([]);
  });

  it('is a dialog named after what it does, with a close button', () => {
    renderModal();
    expect(screen.getByRole('dialog', { name: t().settings.imageGenAddBackend })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t().common.close })).toBeInTheDocument();
    cleanup();

    renderModal(SEEDREAM);
    expect(screen.getByRole('dialog', { name: t().settings.imageGenEditBackend })).toBeInTheDocument();
  });

  it('names every field after its label', () => {
    renderModal();

    expect(screen.getByLabelText(t().settings.imageGenBackendName)).toBe(nameField());
    expect(screen.getByLabelText(t().settings.imageGenBaseUrl)).toBe(addressField());
    expect(screen.getByLabelText(t().settings.imageGenApiKey)).toBe(keyField());
    expect(screen.getByLabelText(t().settings.imageGenModel)).toBe(modelField());
    expect(screen.getByRole('combobox', { name: t().settings.imageGenVendor })).toBeInTheDocument();
  });

  it('closes an untouched form on Escape without asking', async () => {
    const user = userEvent.setup();
    const { onClose } = renderModal();

    await user.keyboard('{Escape}');

    expect(discardQuestion()).not.toBeInTheDocument();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('asks before Escape throws away what was typed, and keeps it when the user says so', async () => {
    const user = userEvent.setup();
    const { onClose } = renderModal();
    type(nameField(), 'Seedream');

    await user.keyboard('{Escape}');

    expect(discardQuestion()).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: t().designSystem.keepEditing }));

    expect(discardQuestion()).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(nameField().value).toBe('Seedream');

    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: t().designSystem.discard }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(log).toEqual([]);
  });

  it('asks before Cancel and the close button throw away what was typed', async () => {
    const user = userEvent.setup();
    const { onClose } = renderModal(SEEDREAM);
    type(modelField(), 'seedream-next');

    await user.click(screen.getByRole('button', { name: t().common.cancel }));
    expect(discardQuestion()).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: t().designSystem.keepEditing }));

    await user.click(screen.getByRole('button', { name: t().common.close }));
    expect(discardQuestion()).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(log).toEqual([]);
  });

  it('stops asking once the form is back to what it opened with', async () => {
    const user = userEvent.setup();
    const { onClose } = renderModal(SEEDREAM);
    type(modelField(), 'seedream-next');
    type(modelField(), 'seedream-test');

    await user.keyboard('{Escape}');

    expect(discardQuestion()).not.toBeInTheDocument();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('saves a filled form without asking anything', async () => {
    const user = userEvent.setup();
    const { onClose } = renderModal();
    type(nameField(), 'Seedream');
    type(addressField(), 'https://images.example.test/api/v3');
    type(modelField(), 'seedream-test');

    await user.click(saveButton());

    expect(discardQuestion()).not.toBeInTheDocument();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(log).toHaveLength(1);
  });

  it('keeps what the user is typing when the same backend changes elsewhere, and still closes without asking when untouched', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const view = render(<ImageGenBackendModal open onClose={onClose} editBackend={SEEDREAM} />, { wrapper: DesignSystemProvider });

    view.rerender(<ImageGenBackendModal open onClose={onClose} editBackend={{ ...SEEDREAM, model: 'changed-elsewhere' }} />);

    expect(modelField().value).toBe('seedream-test');

    await user.keyboard('{Escape}');

    expect(discardQuestion()).not.toBeInTheDocument();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders nothing while closed', () => {
    render(<ImageGenBackendModal open={false} onClose={vi.fn()} />, { wrapper: DesignSystemProvider });

    expect(screen.queryByPlaceholderText(t().settings.imageGenBackendNamePlaceholder)).not.toBeInTheDocument();
  });
});

describe('ImageGenBackendsPanel', () => {
  it('says so when there is no backend', () => {
    renderPanel([]);

    expect(screen.getByText(t().settings.imageGenNoBackends)).toBeInTheDocument();
    expect(screen.getByText(t().settings.imageGenNoBackendsHint)).toBeInTheDocument();
  });

  it('lists each backend with its model, falling back to the name, and marks the default', () => {
    renderPanel([SEEDREAM, DALLE], 'backend-a');

    expect(screen.getByText('seedream-test')).toBeInTheDocument();
    expect(screen.getAllByText('Dall-E')).toHaveLength(2);
    expect(screen.getAllByText(t().settings.imageGenDefaultBadge)).toHaveLength(1);
    expect(document.body.innerHTML).not.toContain(FAKE_KEY);
    expect(document.body.innerHTML).not.toContain('images.example.test');
  });

  it('treats the first backend as the default when none is chosen', () => {
    renderPanel([DALLE, SEEDREAM]);

    expect(screen.getAllByText(t().settings.imageGenDefaultBadge)).toHaveLength(1);
  });

  it('makes a backend the default', async () => {
    renderPanel([SEEDREAM, DALLE], 'backend-a');

    await userEvent.click(rowAction(t().settings.imageGenSetDefault, 1));

    expect(log).toEqual([['setDefaultImageBackend', 'backend-b']]);
  });

  it('hands a backend to onEdit', async () => {
    const { onEdit } = renderPanel([SEEDREAM, DALLE], 'backend-a');

    await userEvent.click(rowAction(t().settings.imageGenEditBackend, 1));

    expect(onEdit).toHaveBeenCalledWith(DALLE);
    expect(log).toEqual([]);
  });

  it('deletes a backend only after the user confirms, and the question names it', async () => {
    renderPanel([SEEDREAM, DALLE], 'backend-a');

    await userEvent.click(rowAction(t().common.delete, 1));

    expect(screen.getByText(t().settings.imageGenDeleteConfirmTitle)).toBeInTheDocument();
    expect(screen.getByText(format(t().settings.imageGenDeleteConfirmMessage, { name: 'Dall-E' }))).toBeInTheDocument();
    expect(log).toEqual([]);

    await userEvent.click(screen.getByRole('button', { name: t().common.cancel }));
    expect(log).toEqual([]);
    expect(screen.queryByText(t().settings.imageGenDeleteConfirmTitle)).not.toBeInTheDocument();

    await userEvent.click(rowAction(t().common.delete, 1));
    await userEvent.click(screen.getAllByRole('button', { name: t().common.delete }).at(-1)!);

    expect(log).toEqual([['removeImageGenBackend', 'backend-b']]);
    expect(useSettingsStore.getState().imageGeneration.backends.map((b) => b.id)).toEqual(['backend-a']);
  });

  it('does nothing when the backend went away while the question was open', async () => {
    renderPanel([SEEDREAM, DALLE], 'backend-a');

    await userEvent.click(rowAction(t().common.delete, 1));
    act(() => { useSettingsStore.setState({ imageGeneration: { backends: [SEEDREAM], defaultId: 'backend-a' } }); });
    await userEvent.click(screen.getByRole('alertdialog').querySelector<HTMLElement>('button:last-of-type')!);

    expect(log).toEqual([]);
    expect(useSettingsStore.getState().imageGeneration.backends.map((b) => b.id)).toEqual(['backend-a']);
  });

  it('shows which backend is the default on the star itself', () => {
    renderPanel([SEEDREAM, DALLE], 'backend-a');

    expect(rowAction(t().settings.imageGenSetDefault, 0)).toHaveAttribute('aria-pressed', 'true');
    expect(rowAction(t().settings.imageGenSetDefault, 1)).toHaveAttribute('aria-pressed', 'false');
    expect(rowAction(t().settings.imageGenSetDefault, 0)).not.toHaveClass('aria-pressed:bg-fill-selected');
  });

  it('keeps the default on Arrow keys and changes it on Enter', async () => {
    const user = userEvent.setup();
    renderPanel([SEEDREAM, DALLE], 'backend-a');

    rowAction(t().settings.imageGenSetDefault, 1).focus();
    await user.keyboard('{ArrowDown}{ArrowUp}');
    expect(log).toEqual([]);

    await user.keyboard('{Enter}');
    expect(log).toEqual([['setDefaultImageBackend', 'backend-b']]);
  });
});
