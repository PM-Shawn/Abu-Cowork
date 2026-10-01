import type { AdapterKind, LLMAdapter } from './adapter';
import { ClaudeAdapter } from './claude';
import { OpenAICompatibleAdapter } from './openai-compatible';
import { OllamaNativeAdapter } from './ollama-native';

/** 壳、sidecar、压缩与技能辅助调用共用的创建入口。 */
export function createAdapterForKind(kind: AdapterKind): LLMAdapter {
  switch (kind) {
    case 'claude':
      return new ClaudeAdapter();
    case 'openai-compatible':
      return new OpenAICompatibleAdapter();
    case 'ollama':
      return new OllamaNativeAdapter();
  }
}
