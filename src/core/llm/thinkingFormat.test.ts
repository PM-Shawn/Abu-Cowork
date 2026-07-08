import { describe, it, expect } from 'vitest';
import { deriveThinkingFormat } from './thinkingFormat';
import type { DeclaredCapabilities } from '@/types/provider';

describe('deriveThinkingFormat', () => {
  describe('host-pattern derivation', () => {
    it('deepseek.com → deepseek', () => {
      expect(deriveThinkingFormat('api.deepseek.com', 'deepseek-chat')).toBe('deepseek');
    });

    it('deepseek.com bare → deepseek', () => {
      expect(deriveThinkingFormat('deepseek.com', 'deepseek-r1')).toBe('deepseek');
    });

    it('api.z.ai → zai', () => {
      expect(deriveThinkingFormat('api.z.ai', 'glm-4')).toBe('zai');
    });

    it('z.ai (root) → zai', () => {
      expect(deriveThinkingFormat('z.ai', 'glm-4')).toBe('zai');
    });

    it('api.together.ai → together', () => {
      expect(deriveThinkingFormat('api.together.ai', 'some-model')).toBe('together');
    });

    it('together.xyz → together', () => {
      expect(deriveThinkingFormat('together.xyz', 'some-model')).toBe('together');
    });

    it('openrouter.ai → openrouter', () => {
      expect(deriveThinkingFormat('openrouter.ai', 'some-model')).toBe('openrouter');
    });

    it('api.openrouter.ai → openrouter', () => {
      expect(deriveThinkingFormat('api.openrouter.ai', 'some-model')).toBe('openrouter');
    });

    it('dashscope.aliyuncs.com → qwen', () => {
      expect(deriveThinkingFormat('dashscope.aliyuncs.com', 'qwen-plus')).toBe('qwen');
    });

    it('aliyun in host → qwen', () => {
      expect(deriveThinkingFormat('my-proxy.aliyun.example.com', 'qwen-max')).toBe('qwen');
    });

    it('qwen in host → qwen', () => {
      expect(deriveThinkingFormat('qwen.example.com', 'qwen-max')).toBe('qwen');
    });

    it('api.openai.com → openai (no translation)', () => {
      expect(deriveThinkingFormat('api.openai.com', 'gpt-4o')).toBe('openai');
    });

    it('random custom host → openai (safe default)', () => {
      expect(deriveThinkingFormat('my-llm-proxy.internal', 'custom-model')).toBe('openai');
    });

    it('localhost → openai (safe default)', () => {
      expect(deriveThinkingFormat('localhost:11434', 'llama3')).toBe('openai');
    });
  });

  describe('explicit caps.thinkingFormat override', () => {
    it('caps.thinkingFormat overrides even when host matches deepseek', () => {
      const caps: DeclaredCapabilities = { thinkingFormat: 'qwen-chat-template' };
      expect(deriveThinkingFormat('api.deepseek.com', 'deepseek-r1', caps)).toBe('qwen-chat-template');
    });

    it('caps.thinkingFormat = openai overrides a deepseek host', () => {
      const caps: DeclaredCapabilities = { thinkingFormat: 'openai' };
      expect(deriveThinkingFormat('api.deepseek.com', 'deepseek-chat', caps)).toBe('openai');
    });

    it('caps.thinkingFormat = zai on a generic host → zai', () => {
      const caps: DeclaredCapabilities = { thinkingFormat: 'zai' };
      expect(deriveThinkingFormat('my-custom-proxy.example.com', 'some-model', caps)).toBe('zai');
    });

    it('caps.thinkingFormat = together on openrouter host → together (override wins)', () => {
      const caps: DeclaredCapabilities = { thinkingFormat: 'together' };
      expect(deriveThinkingFormat('openrouter.ai', 'model', caps)).toBe('together');
    });
  });

  describe('case-insensitivity', () => {
    it('uppercase DEEPSEEK.COM still matches deepseek', () => {
      expect(deriveThinkingFormat('API.DEEPSEEK.COM', 'deepseek-r1')).toBe('deepseek');
    });

    it('mixed-case Together.AI still matches together', () => {
      expect(deriveThinkingFormat('API.Together.AI', 'model')).toBe('together');
    });

    it('uppercase OPENROUTER.AI still matches openrouter', () => {
      expect(deriveThinkingFormat('OPENROUTER.AI', 'model')).toBe('openrouter');
    });
  });

  describe('edge cases', () => {
    it('empty string host → openai (safe default)', () => {
      expect(deriveThinkingFormat('', 'model')).toBe('openai');
    });

    it('garbage host string → openai (safe default)', () => {
      expect(deriveThinkingFormat('not-a-valid-host-!@#$', 'model')).toBe('openai');
    });

    it('undefined caps → falls through to host derivation', () => {
      expect(deriveThinkingFormat('api.deepseek.com', 'deepseek-r1', undefined)).toBe('deepseek');
    });

    it('caps without thinkingFormat → falls through to host derivation', () => {
      const caps: DeclaredCapabilities = { supportsTools: true };
      expect(deriveThinkingFormat('api.deepseek.com', 'deepseek-r1', caps)).toBe('deepseek');
    });
  });
});
