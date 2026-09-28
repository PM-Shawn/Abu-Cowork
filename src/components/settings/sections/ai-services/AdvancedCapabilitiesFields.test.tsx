// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { useState } from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getLanguageSetting, initLanguage, type LanguageSetting } from '@/i18n';
import type { ModelDeclaredCapabilities } from '@/types/provider';
import AdvancedCapabilitiesFields from './AdvancedCapabilitiesFields';

function Harness({ detected, estimated }: { detected?: number; estimated: number }) {
  const [declared, setDeclared] = useState<ModelDeclaredCapabilities>({});
  return (
    <>
      <AdvancedCapabilitiesFields
        declared={declared}
        setDeclared={setDeclared}
        apiFormat="openai-compatible"
        detectedContextWindow={detected}
        estimatedContextWindow={estimated}
      />
      <output data-testid="context-length">{declared.maxInputTokens ?? ''}</output>
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
    expect(screen.getByText('模型一次能记住的对话长度')).toBeInTheDocument();
  });

  it('shows the length the service reported', () => {
    render(<Harness detected={8192} estimated={32768} />);
    expect(screen.getByPlaceholderText('已识别：8K')).toBeInTheDocument();
  });

  it('says what blank means when nothing was reported', () => {
    render(<Harness estimated={32768} />);
    expect(screen.getByPlaceholderText('未识别，留空按 32K 估计')).toBeInTheDocument();
  });

  it('offers 8K and 16K and takes the picked value', async () => {
    render(<Harness estimated={32768} />);
    // 「最大输出」一栏也有 8K、16K，限定在「上下文长度」这一栏里找
    const field = within(screen.getByText('上下文长度').parentElement as HTMLElement);
    expect(field.getAllByRole('button').map((button) => button.textContent))
      .toEqual(['8K', '16K', '32K', '64K', '128K', '256K']);
    await userEvent.click(field.getByRole('button', { name: '8K' }));
    expect(screen.getByTestId('context-length')).toHaveTextContent('8192');
    await userEvent.click(field.getByRole('button', { name: '16K' }));
    expect(screen.getByTestId('context-length')).toHaveTextContent('16384');
  });

  it('labels the image checkbox 能看图 with its explanation', () => {
    render(<Harness estimated={32768} />);
    expect(screen.getByText('能看图')).toBeInTheDocument();
    expect(screen.getByText('模型能识别图片和屏幕截图')).toBeInTheDocument();
  });
});
