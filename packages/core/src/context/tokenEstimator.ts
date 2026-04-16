import type {
  Message,
  MessageContent,
  ToolDefinition,
} from '../../../../src/types';
import { getMessageText } from './contextUtils';

const CJK_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef]/g;
const CALIBRATION_ALPHA = 0.3;
const TOKENS_PER_IMAGE = 1600;

/**
 * TokenEstimator —— 基于字符的 token 估算器，带按模型校准。
 *
 * 对比 Abu 原版改动：
 * - 原版使用模块级 Map + mutable `activeModelId` 全局 state；
 * - 新版改为类实例，支持多实例（测试/多租户场景）。
 */
export class TokenEstimator {
  private calibrationRatios = new Map<string, number>();
  private activeModelId = '';

  setActiveModel(modelId: string): void {
    this.activeModelId = modelId;
  }

  calibrateFromUsage(estimatedTokens: number, actualTokens: number): void {
    if (estimatedTokens <= 0 || actualTokens <= 0) return;
    const key = this.activeModelId || '_default';
    const oldRatio = this.calibrationRatios.get(key) ?? 1.0;
    const newRatio = actualTokens / estimatedTokens;
    this.calibrationRatios.set(
      key,
      CALIBRATION_ALPHA * newRatio + (1 - CALIBRATION_ALPHA) * oldRatio
    );
  }

  getCalibrationRatio(): number {
    return this.calibrationRatios.get(this.activeModelId || '_default') ?? 1.0;
  }

  resetCalibration(modelId?: string): void {
    if (modelId) this.calibrationRatios.delete(modelId);
    else this.calibrationRatios.clear();
  }

  estimateTokens(text: string): number {
    if (!text) return 0;
    const cjkMatches = text.match(CJK_REGEX);
    const cjkCount = cjkMatches?.length ?? 0;
    const nonCjkCount = text.length - cjkCount;
    const cjkTokens = cjkCount / 1.5;
    const nonCjkTokens = nonCjkCount / 4;
    return Math.ceil((cjkTokens + nonCjkTokens) * this.getCalibrationRatio());
  }

  private countImages(content: string | MessageContent[]): number {
    if (typeof content === 'string') return 0;
    return content.filter((c) => c.type === 'image').length;
  }

  estimateMessageTokens(messages: Message[]): number {
    let total = 0;
    for (const msg of messages) {
      total += this.estimateTokens(getMessageText(msg.content));
      total += this.countImages(msg.content) * TOKENS_PER_IMAGE;
      if (msg.thinking) total += this.estimateTokens(msg.thinking);

      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          total += this.estimateTokens(tc.name);
          total += this.estimateTokens(JSON.stringify(tc.input));
          if (tc.result) total += this.estimateTokens(tc.result);
        }
      }
      if (msg.toolCallsForContext) {
        for (const tc of msg.toolCallsForContext) {
          total += this.estimateTokens(tc.name);
          total += this.estimateTokens(JSON.stringify(tc.input));
          total += this.estimateTokens(tc.result);
        }
      }
      total += 4;
    }
    return total;
  }

  estimateToolSchemaTokens(tools: ToolDefinition[]): number {
    let total = 0;
    for (const tool of tools) {
      total += this.estimateTokens(tool.name);
      total += this.estimateTokens(tool.description);
      total += this.estimateTokens(JSON.stringify(tool.inputSchema));
      total += 10;
    }
    return total;
  }
}
