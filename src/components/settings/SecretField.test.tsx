// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { useState } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
import { initLanguage } from '@/i18n';
import SecretField from './SecretField';

const FAKE_KEY = 'sk-test-not-a-secret';

function Controlled({ initial = '', onChange, disabled }: { initial?: string; onChange?: (value: string) => void; disabled?: boolean }) {
  const [value, setValue] = useState(initial);
  return (
    <SecretField
      id="key-field"
      placeholder="Enter the key"
      value={value}
      disabled={disabled}
      onChange={(next) => { setValue(next); onChange?.(next); }}
    />
  );
}

function renderField(props: Parameters<typeof Controlled>[0] = {}) {
  return render(<Controlled {...props} />, { wrapper: DesignSystemProvider });
}

const input = () => screen.getByPlaceholderText('Enter the key') as HTMLInputElement;

// Every place outside the input's own value where a key could end up readable.
function everythingButTheValue(): string {
  const parts = [document.body.textContent ?? ''];
  for (const element of document.body.querySelectorAll('*')) {
    for (const attribute of element.attributes) {
      if (element === input() && attribute.name === 'value') continue;
      parts.push(`${attribute.name}=${attribute.value}`);
    }
  }
  return parts.join('\n');
}

describe('SecretField', () => {
  beforeEach(() => { initLanguage('en-US'); });
  afterEach(cleanup);

  it('hides what is typed until the user asks to see it', async () => {
    const user = userEvent.setup();
    renderField({ initial: FAKE_KEY });

    expect(input()).toHaveAttribute('type', 'password');
    const show = screen.getByRole('button', { name: 'Show key' });
    expect(show).toHaveAttribute('aria-pressed', 'false');

    await user.click(show);

    expect(input()).toHaveAttribute('type', 'text');
    const hide = screen.getByRole('button', { name: 'Hide key' });
    expect(hide).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('button', { name: 'Show key' })).not.toBeInTheDocument();

    await user.click(hide);

    expect(input()).toHaveAttribute('type', 'password');
    expect(screen.getByRole('button', { name: 'Show key' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('keeps the plain look while the key is shown, because the icon already says so', async () => {
    const user = userEvent.setup();
    renderField();

    await user.click(screen.getByRole('button', { name: 'Show key' }));

    expect(screen.getByRole('button', { name: 'Hide key' })).not.toHaveClass('aria-pressed:bg-fill-selected');
  });

  it('reports each change as a string', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderField({ onChange });

    await user.type(input(), 'ab');

    expect(onChange.mock.calls).toEqual([['a'], ['ab']]);
    expect(input().value).toBe('ab');
  });

  it('takes a pasted key whole', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderField({ onChange });

    await user.click(input());
    await user.paste(FAKE_KEY);

    expect(onChange.mock.calls).toEqual([[FAKE_KEY]]);
    expect(input().value).toBe(FAKE_KEY);
  });

  it('switches off both the field and the button when disabled', () => {
    renderField({ disabled: true });

    expect(input()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Show key' })).toBeDisabled();
  });

  it('puts the id and the placeholder on the input and adds no other input attributes', () => {
    renderField();

    expect(input()).toHaveAttribute('id', 'key-field');
    expect(input().getAttributeNames().sort()).toEqual(['class', 'id', 'placeholder', 'type', 'value']);
  });

  it('never writes the key anywhere but the value of the input, hidden or shown', async () => {
    const user = userEvent.setup();
    renderField({ initial: FAKE_KEY });

    expect(everythingButTheValue()).not.toContain(FAKE_KEY);

    const show = screen.getByRole('button', { name: 'Show key' });
    await user.hover(show);
    await user.click(show);

    expect(input().value).toBe(FAKE_KEY);
    expect(everythingButTheValue()).not.toContain(FAKE_KEY);
    expect(screen.getByRole('button', { name: 'Hide key' })).toHaveAttribute('aria-label', 'Hide key');
  });
});
