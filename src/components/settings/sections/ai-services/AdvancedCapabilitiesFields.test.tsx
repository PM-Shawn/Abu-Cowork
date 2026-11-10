// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { useState, type ReactElement } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getLanguageSetting, initLanguage, type LanguageSetting } from '@/i18n';
import { DesignSystemProvider } from '@/components/ds/provider';
import type { ApiFormat } from '@/types';
import type { ModelDeclaredCapabilities } from '@/types/provider';
import AdvancedCapabilitiesFields from './AdvancedCapabilitiesFields';

function Harness({ detected, estimated, initial, apiFormat = 'openai-compatible' }: {
  detected?: number;
  estimated: number;
  initial?: ModelDeclaredCapabilities;
  apiFormat?: ApiFormat;
}) {
  const [declared, setDeclared] = useState<ModelDeclaredCapabilities>(initial ?? {});
  return (
    <>
      <AdvancedCapabilitiesFields
        declared={declared}
        setDeclared={setDeclared}
        apiFormat={apiFormat}
        contextWindow={{
          size: Math.min(detected ?? estimated, 200000),
          uncappedSize: detected ?? estimated,
          source: detected === undefined ? 'estimate' : 'service',
        }}
      />
      <output data-testid="context-length">{declared.maxInputTokens ?? ''}</output>
      <output data-testid="declared">{JSON.stringify(declared)}</output>
    </>
  );
}

describe('AdvancedCapabilitiesFields', () => {
  let previous: LanguageSetting;

  beforeEach(() => {
    previous = getLanguageSetting();
    initLanguage('zh-CN');
  });

  afterEach(() => {
    cleanup();
    initLanguage(previous);
  });

  it('names the field 上下文长度 and explains it', () => {
    render(<Harness estimated={32768} />);
    expect(screen.getByText('上下文长度')).toBeInTheDocument();
    expect(screen.getByText('阿布每次处理的内容上限')).toBeInTheDocument();
  });

  it('names the 能看图 checkbox so it can be found by its label', async () => {
    render(<Harness estimated={32768} />);
    const canSeeImages = screen.getByRole('checkbox', { name: '能看图' });
    expect(canSeeImages).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(canSeeImages);
    expect(canSeeImages).toHaveAttribute('aria-checked', 'true');
  });

  it('shows the length the service reported', () => {
    render(<Harness detected={8192} estimated={32768} />);
    expect(screen.getByText('模型支持 8K')).toBeInTheDocument();
    expect(screen.getByText('当前使用 8K（默认）')).toBeInTheDocument();
  });

  it('says what blank means when nothing was reported', () => {
    render(<Harness estimated={32768} />);
    expect(screen.getByPlaceholderText('留空使用 32K')).toBeInTheDocument();
    expect(screen.getByText('估计支持 32K')).toBeInTheDocument();
    expect(screen.getByText('当前使用 32K（默认）')).toBeInTheDocument();
  });

  it('offers 8K and 16K and takes the picked value', async () => {
    render(<Harness estimated={32768} />);
    // Output presets share these labels; scope the lookup to the context field.
    const field = within(screen.getByText('上下文长度').parentElement as HTMLElement);
    expect(field.getAllByRole('button').map((button) => button.textContent))
      .toEqual(['8K', '16K', '32K', '64K', '128K', '256K', '1M']);
    await userEvent.click(field.getByRole('button', { name: '8K' }));
    expect(screen.getByTestId('context-length')).toHaveTextContent('8192');
    await userEvent.click(field.getByRole('button', { name: '16K' }));
    expect(screen.getByTestId('context-length')).toHaveTextContent('16384');
  });

  it('keeps model capacity visible when choosing 1M and clearing back to the default', async () => {
    render(<Harness detected={1_000_000} estimated={32768} />);
    const input = screen.getByRole('textbox', { name: '上下文长度' });
    const preset = screen.getByRole('button', { name: '1M' });
    expect(input).toHaveAccessibleDescription('阿布每次处理的内容上限 模型支持 1M 当前使用 200K（默认）');
    expect(input).toHaveValue('');
    expect(preset).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(preset);
    expect(input).toHaveValue('1000000');
    expect(preset).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('模型支持 1M')).toBeInTheDocument();
    expect(screen.getByText('当前使用 1M')).toBeInTheDocument();
    expect(screen.queryByText('当前使用 200K（默认）')).not.toBeInTheDocument();
    await userEvent.clear(input);
    expect(screen.getByText('当前使用 200K（默认）')).toBeInTheDocument();
    expect(preset).toHaveAttribute('aria-pressed', 'false');
  });

  it('shows an uncapped estimate alongside the default and updates after switching models', () => {
    const { rerender } = render(<Harness estimated={1_000_000} />);
    expect(screen.getByText('估计支持 1M')).toBeInTheDocument();
    expect(screen.getByText('当前使用 200K（默认）')).toBeInTheDocument();
    rerender(<Harness estimated={128000} />);
    expect(screen.getByText('估计支持 128K')).toBeInTheDocument();
    expect(screen.getByText('当前使用 128K（默认）')).toBeInTheDocument();
    expect(screen.queryByText(/200K/)).not.toBeInTheDocument();
  });

  it('follows manual input with the same positive integer rule as the runtime', () => {
    render(<Harness detected={1_000_000} estimated={32768} />);
    const input = screen.getByRole('textbox', { name: '上下文长度' });
    fireEvent.change(input, { target: { value: '500000' } });
    expect(screen.getByText('当前使用 500K')).toBeInTheDocument();
    expect(screen.getByText('模型支持 1M')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '1M' })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.change(input, { target: { value: '1' } });
    expect(screen.getByText('当前使用 1')).toBeInTheDocument();
    fireEvent.change(input, { target: { value: '0' } });
    expect(screen.getByText('当前使用 200K（默认）')).toBeInTheDocument();
    fireEvent.change(input, { target: { value: '9007199254740992' } });
    expect(screen.getByText('当前使用 200K（默认）')).toBeInTheDocument();
  });

  it('labels the image checkbox 能看图 with its explanation', () => {
    render(<Harness estimated={32768} />);
    expect(screen.getByText('能看图')).toBeInTheDocument();
    expect(screen.getByText('模型能识别图片和屏幕截图')).toBeInTheDocument();
  });

  it('ties the explanation to the 能看图 checkbox, and to no other checkbox', () => {
    render(<Harness estimated={32768} />);
    expect(screen.getByRole('checkbox', { name: '能看图' })).toHaveAccessibleDescription('模型能识别图片和屏幕截图');
    expect(screen.getByRole('checkbox', { name: '工具调用' })).not.toHaveAttribute('aria-describedby');
  });

  describe('思考强度', () => {
    const renderWithProvider = (ui: ReactElement) => render(ui, { wrapper: DesignSystemProvider });
    const declaredNow = () => JSON.parse(screen.getByTestId('declared').textContent ?? '{}') as ModelDeclaredCapabilities;
    const effortSelect = () => screen.getByRole('combobox', { name: '思考强度' });
    const pick = async (label: string) => {
      await userEvent.click(effortSelect());
      await userEvent.click(screen.getByRole('option', { name: label }));
    };

    it('appears only once 思考模式 is ticked, and starts on 默认', async () => {
      renderWithProvider(<Harness estimated={32768} />);
      expect(screen.queryByRole('combobox', { name: '思考强度' })).toBeNull();
      await userEvent.click(screen.getByRole('checkbox', { name: '思考模式' }));
      expect(effortSelect()).toHaveTextContent('默认');
      expect(declaredNow().thinkingEffort).toBeUndefined();
    });

    it('offers 默认 / 关闭 / 低 / 高 / 最高', async () => {
      renderWithProvider(<Harness estimated={32768} initial={{ supportsReasoning: true }} />);
      await userEvent.click(effortSelect());
      expect(screen.getAllByRole('option').map((option) => option.textContent))
        .toEqual(['默认', '关闭', '低', '高', '最高']);
    });

    it.each([
      ['关闭', 'off'],
      ['低', 'low'],
      ['高', 'high'],
      ['最高', 'max'],
    ] as const)('picking %s stores %s on the model', async (label, value) => {
      renderWithProvider(<Harness estimated={32768} initial={{ supportsReasoning: true }} />);
      await pick(label);
      expect(declaredNow().thinkingEffort).toBe(value);
      expect(effortSelect()).toHaveTextContent(label);
    });

    it('picking 默认 again clears the stored effort', async () => {
      renderWithProvider(<Harness estimated={32768} initial={{ supportsReasoning: true, thinkingEffort: 'max' }} />);
      expect(effortSelect()).toHaveTextContent('最高');
      await pick('默认');
      expect(declaredNow().thinkingEffort).toBeUndefined();
      expect(effortSelect()).toHaveTextContent('默认');
    });

    it('keeps the other declared fields when the effort changes', async () => {
      renderWithProvider(<Harness estimated={32768} initial={{ supportsReasoning: true, supportsTools: true, supportedEfforts: ['high'], maxInputTokens: 65536 }} />);
      await pick('低');
      expect(declaredNow()).toEqual({ supportsReasoning: true, supportsTools: true, supportedEfforts: ['high'], maxInputTokens: 65536, thinkingEffort: 'low' });
    });

    it('shows a stored value the list does not know as 默认 rather than guessing', () => {
      renderWithProvider(<Harness estimated={32768} initial={{ supportsReasoning: true, thinkingEffort: 'ultra' as never }} />);
      expect(effortSelect()).toHaveTextContent('默认');
    });

    it('stays next to 思考档位 on an OpenAI-compatible endpoint', () => {
      renderWithProvider(<Harness estimated={32768} initial={{ supportsReasoning: true }} />);
      expect(screen.getByText('思考档位')).toBeInTheDocument();
      expect(effortSelect()).toBeInTheDocument();
    });

    it('is offered on an Anthropic-format endpoint too, where 思考档位 does not apply', () => {
      renderWithProvider(<Harness estimated={32768} apiFormat="anthropic" initial={{ supportsReasoning: true }} />);
      expect(screen.queryByText('思考档位')).toBeNull();
      expect(effortSelect()).toBeInTheDocument();
    });

    it('explains what 默认 and 关闭 mean', () => {
      renderWithProvider(<Harness estimated={32768} initial={{ supportsReasoning: true }} />);
      expect(screen.getByText(/默认沿用阿布对该模型的内置设置/)).toBeInTheDocument();
    });

    it('speaks English in the English interface', async () => {
      initLanguage('en-US');
      renderWithProvider(<Harness estimated={32768} initial={{ supportsReasoning: true }} />);
      await userEvent.click(screen.getByRole('combobox', { name: 'Thinking effort' }));
      expect(screen.getAllByRole('option').map((option) => option.textContent))
        .toEqual(['Default', 'Off', 'Low', 'High', 'Max']);
    });
  });
});
