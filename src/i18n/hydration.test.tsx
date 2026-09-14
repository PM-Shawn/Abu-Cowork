// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { initLanguage, useI18n } from './index';

afterEach(() => { cleanup(); initLanguage('system'); });

it('updates mounted consumers when persisted language is restored after startup', async () => {
  initLanguage('en-US');
  const { result } = renderHook(() => useI18n());
  expect(result.current.locale).toBe('en-US');
  await act(async () => { await Promise.resolve(); initLanguage('zh-CN'); });
  expect(result.current.locale).toBe('zh-CN');
  await act(async () => { await Promise.resolve(); initLanguage('en-US'); });
  expect(result.current.locale).toBe('en-US');
});
