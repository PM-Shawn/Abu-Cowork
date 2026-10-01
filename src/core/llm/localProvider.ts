import type { ProviderInstance } from '@/types/provider';

export type LocalServerKind = 'ollama' | 'lmstudio' | 'custom-local';

const LOOPBACK_V4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** 地址是否指向本机。URL 解析会把 2130706433 这类写法规范成 127.0.0.1。 */
export function isLoopbackUrl(rawUrl: string): boolean {
  const trimmed = rawUrl.trim();
  if (!trimmed) return false;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  if (!URL.canParse(withScheme)) return false;
  const host = new URL(withScheme).hostname.toLowerCase();
  return host === 'localhost'
    || host.endsWith('.localhost')
    || host === '[::1]'
    || host === '0.0.0.0'
    || LOOPBACK_V4.test(host);
}

/** 服务商类型为 Ollama / LM Studio，或自定义服务商地址在本机，即为本地服务商。 */
export function localServerKind(
  provider: Pick<ProviderInstance, 'id' | 'source' | 'baseUrl'> | undefined,
): LocalServerKind | null {
  if (!provider) return null;
  if (provider.id === 'ollama') return 'ollama';
  if (provider.id === 'lmstudio') return 'lmstudio';
  if (provider.source === 'custom' && isLoopbackUrl(provider.baseUrl)) return 'custom-local';
  return null;
}
