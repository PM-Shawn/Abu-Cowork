import { afterEach, describe, expect, it } from 'vitest';
import { initLanguage } from '@/i18n';
import { mapAIServiceError } from './errorMap';

describe('mapAIServiceError', () => {
  afterEach(() => {
    initLanguage('zh-CN');
  });

  it.each([
    ['zh-CN', '上游内容安全系统拒绝了请求（通常由对话历史触发，可尝试新开会话继续）'],
    ['en-US', 'The upstream content-safety system rejected the request (often triggered by conversation history; try continuing in a new conversation)'],
  ] as const)('maps content_policy without steering users to API-key settings in %s', (locale, expected) => {
    initLanguage(locale);

    const mapped = mapAIServiceError({
      errorCode: 'content_policy',
      statusCode: 403,
      rawMessage: 'The request was rejected by the content safety system.',
    });

    expect(mapped).toEqual({ message: expected });
  });

  it.each([
    'budget has been exceeded',
    'UnsupportedModel',
    'timeout (30s)',
    'forbidden',
  ])('keeps the structured content_policy classification ahead of conflicting raw text: %s', (rawMessage) => {
    const mapped = mapAIServiceError({
      errorCode: 'content_policy',
      statusCode: 403,
      rawMessage,
    });

    expect(mapped).toEqual({
      message: '上游内容安全系统拒绝了请求（通常由对话历史触发，可尝试新开会话继续）',
    });
  });
});
