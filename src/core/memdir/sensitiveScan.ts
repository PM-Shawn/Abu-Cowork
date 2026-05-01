/**
 * Sensitive content detection — used by the v0.15 onboarding audit dialog
 * to suggest making certain memories private. NOT used during normal
 * memory writes (that's contentGuard's job, with a different purpose).
 *
 * Detects PII patterns common in Chinese desktop users' memories:
 * 身份证 (ID card), 银行卡 (bank card), 手机号 (mobile), 邮箱+密码 combos.
 *
 * False positives are tolerated (user reviews the audit before confirming).
 * False negatives (missed sensitive data) are the real concern, so patterns
 * err on the side of recall over precision.
 */

import type { MemoryHeader } from './types';
import { readMemoryFile } from './scan';

export type SensitivePatternId =
  | 'cn_id_card'
  | 'bank_card'
  | 'mobile_phone'
  | 'email_with_password'
  | 'salary_keyword';

export interface SensitiveMatch {
  patternId: SensitivePatternId;
  /** Human-readable reason shown in the audit UI */
  reason: string;
}

export interface SensitiveAuditResult {
  header: MemoryHeader;
  matches: SensitiveMatch[];
}

// ── Patterns ──

/**
 * Chinese ID card: 18 digits where the last can be X. We don't validate the
 * checksum (overkill for a heuristic scan).
 */
const RE_CN_ID = /(?<![0-9])(?:[1-9]\d{5})(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?![0-9])/;

/**
 * Bank card: 13-19 digit run, optionally with single spaces or dashes.
 * Strip separators before counting digits to keep the check tight.
 */
const RE_BANK = /(?<![0-9])(?:\d[ -]?){12,18}\d(?![0-9])/;

/**
 * Chinese mobile: 1[3-9] + 9 digits. Anchored to non-digit boundaries.
 */
const RE_MOBILE = /(?<![0-9])1[3-9]\d{9}(?![0-9])/;

/**
 * Email + something that smells like a password nearby (within 30 chars):
 * matches "email: foo@bar.com password: xxxxx" patterns.
 */
const RE_EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const RE_PASSWORD_KW = /(密码|password|pwd|passwd)[\s::=]+\S{4,}/i;

/**
 * Salary / financial keywords combined with a large number.
 */
const RE_SALARY_KW = /(薪[资水]|工资|年薪|月薪|奖金|股权|期权|salary|bonus)/;
const RE_MONEY = /(?:[¥$]|RMB)\s*\d{4,}|\d{4,}\s*(?:元|块|RMB|美金|美元|人民币)/;

// ── Public API ──

/**
 * Scan a single text body for sensitive patterns.
 * Returns an empty array if no matches.
 */
export function scanText(text: string): SensitiveMatch[] {
  const matches: SensitiveMatch[] = [];

  if (RE_CN_ID.test(text)) {
    matches.push({ patternId: 'cn_id_card', reason: '检测到身份证号格式' });
  }

  // Bank card check: extract candidate runs first, then verify digit count
  const bankCandidate = text.match(RE_BANK);
  if (bankCandidate) {
    const digits = bankCandidate[0].replace(/[ -]/g, '');
    if (digits.length >= 13 && digits.length <= 19) {
      matches.push({ patternId: 'bank_card', reason: '检测到银行卡号格式' });
    }
  }

  if (RE_MOBILE.test(text)) {
    matches.push({ patternId: 'mobile_phone', reason: '检测到手机号' });
  }

  // Email + nearby password keyword
  const emailMatch = text.match(RE_EMAIL);
  if (emailMatch) {
    const idx = emailMatch.index ?? 0;
    const window = text.slice(Math.max(0, idx - 30), idx + emailMatch[0].length + 30);
    if (RE_PASSWORD_KW.test(window)) {
      matches.push({
        patternId: 'email_with_password',
        reason: '检测到邮箱+密码组合',
      });
    }
  }

  // Salary keyword + dollar/yuan number
  if (RE_SALARY_KW.test(text) && RE_MONEY.test(text)) {
    matches.push({
      patternId: 'salary_keyword',
      reason: '检测到薪资/财务相关数字',
    });
  }

  return matches;
}

/**
 * Audit all non-private memories. Returns only the ones that flagged.
 * Caller decides what to do (typically: show in dialog, let user confirm).
 */
export async function auditMemories(headers: readonly MemoryHeader[]): Promise<SensitiveAuditResult[]> {
  const results: SensitiveAuditResult[] = [];
  for (const h of headers) {
    if (h.private) continue; // Already private, no need to flag

    // Combine description + body for the scan. Frontmatter values like
    // `name` / `description` themselves may contain sensitive data.
    const file = await readMemoryFile(h.filePath);
    const body = file?.content ?? '';
    const haystack = `${h.name}\n${h.description}\n${body}`;

    const matches = scanText(haystack);
    if (matches.length > 0) {
      results.push({ header: h, matches });
    }
  }
  return results;
}
