import { describe, expect, it } from 'vitest';
import zhCN from '@/i18n/locales/zh-CN';
import { describeManagedModelRevoked, describeManagedProviderUnreachable, describeModelUnavailable } from './modelUnavailableCopy';

describe('describeManagedModelRevoked', () => {
  it('asks for another pick without naming a service', () => {
    const copy = describeManagedModelRevoked(zhCN.chat, 'org-model-b');
    expect(copy.toast).toBe('模型「org-model-b」已不可用，请重新选择');
    expect(copy.inTask).toBe('这个任务使用的模型「org-model-b」已不可用，没有发送。请在输入框里重新选择一个模型。');
  });
});

describe('describeModelUnavailable', () => {
  it('fills model and reason into all three surfaces', () => {
    const copy = describeModelUnavailable(zhCN.chat, 'provider-removed', 'Model A');
    expect(copy.label).toBe('Model A（不可用）');
    expect(copy.toast).toBe('模型「Model A」所属服务已删除，请换一个模型再发送');
    expect(copy.inTask).toBe('这个任务使用的模型「Model A」所属服务已删除，没有发送。请在输入框里换一个模型后重试。');
  });

  it.each([
    ['provider-disabled', '所属服务已关闭'],
    ['model-removed', '已从所属服务中移除'],
  ] as const)('maps %s to its reason text', (reason, text) => {
    expect(describeModelUnavailable(zhCN.chat, reason, 'M').toast).toContain(text);
  });
});

describe('describeManagedProviderUnreachable', () => {
  const managed = { source: 'managed', name: 'MAZG' } as const;

  it.each(['network_error', 'network_blocked'])('names the organization when the request fails with %s', (code) => {
    expect(describeManagedProviderUnreachable(zhCN.chat, managed, code))
      .toBe('暂时连不上 MAZG 的模型服务。请检查网络后重试，也可以在输入框里换一个模型。');
  });

  it.each(['authentication', 'rate_limit', 'server_error', undefined])(
    'leaves a managed provider\'s %s failure to the ordinary error text',
    (code) => {
      expect(describeManagedProviderUnreachable(zhCN.chat, managed, code)).toBeNull();
    },
  );

  it('leaves the user\'s own providers to the ordinary error text', () => {
    expect(describeManagedProviderUnreachable(zhCN.chat, { source: 'custom', name: 'Mine' }, 'network_error')).toBeNull();
    expect(describeManagedProviderUnreachable(zhCN.chat, undefined, 'network_error')).toBeNull();
  });
});
