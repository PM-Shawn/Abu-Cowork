/**
 * Adapter Registry — platform lookup and plugin-style registration
 */

import type { IMAdapter, AdapterConfig } from './types';
import { DchatAdapter } from './dchat';
import { FeishuAdapter } from './feishu';
import { DingtalkAdapter } from './dingtalk';
import { WecomAdapter } from './wecom';
import { SlackAdapter } from './slack';
import { CustomAdapter } from './custom';

const adapters: Record<string, IMAdapter> = {
  dchat: new DchatAdapter(),
  feishu: new FeishuAdapter(),
  dingtalk: new DingtalkAdapter(),
  wecom: new WecomAdapter(),
  slack: new SlackAdapter(),
  custom: new CustomAdapter(),
};

export function getAdapter(platform: string): IMAdapter | undefined {
  return adapters[platform];
}

export function getAvailablePlatforms(): AdapterConfig[] {
  return Object.values(adapters).map((a) => a.config);
}

/** Dynamic registration for future plugin extension */
export function registerAdapter(adapter: IMAdapter): void {
  adapters[adapter.config.platform] = adapter;
}

// Re-export types for convenience
export type { IMAdapter, AdapterConfig } from './types';
