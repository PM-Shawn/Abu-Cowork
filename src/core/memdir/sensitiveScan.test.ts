import { describe, it, expect } from 'vitest';
import { scanText } from './sensitiveScan';

describe('scanText', () => {
  it('detects Chinese ID card', () => {
    const matches = scanText('我的身份证是 110105199003078412 ，记一下');
    expect(matches.find(m => m.patternId === 'cn_id_card')).toBeTruthy();
  });

  it('detects bank card', () => {
    const matches = scanText('信用卡号 6228480402564890018 已绑定');
    expect(matches.find(m => m.patternId === 'bank_card')).toBeTruthy();
  });

  it('detects bank card with separators', () => {
    const matches = scanText('卡号 6228 4804 0256 4890 018');
    expect(matches.find(m => m.patternId === 'bank_card')).toBeTruthy();
  });

  it('detects mobile phone', () => {
    const matches = scanText('我的电话是 13912345678');
    expect(matches.find(m => m.patternId === 'mobile_phone')).toBeTruthy();
  });

  it('does not flag short digit runs as bank cards', () => {
    const matches = scanText('订单号 12345');
    expect(matches.find(m => m.patternId === 'bank_card')).toBeFalsy();
  });

  it('detects email with nearby password', () => {
    const matches = scanText('登录账号 alice@example.com  密码: hunter2zzz');
    expect(matches.find(m => m.patternId === 'email_with_password')).toBeTruthy();
  });

  it('does not flag standalone email', () => {
    const matches = scanText('联系方式 alice@example.com');
    expect(matches.find(m => m.patternId === 'email_with_password')).toBeFalsy();
  });

  it('detects salary keyword + money', () => {
    const matches = scanText('我的年薪是 600000 元');
    expect(matches.find(m => m.patternId === 'salary_keyword')).toBeTruthy();
  });

  it('detects salary with currency symbol', () => {
    const matches = scanText('月薪 ¥30000');
    expect(matches.find(m => m.patternId === 'salary_keyword')).toBeTruthy();
  });

  it('does not flag salary keyword alone', () => {
    const matches = scanText('讨论了薪资问题');
    expect(matches.find(m => m.patternId === 'salary_keyword')).toBeFalsy();
  });

  it('returns empty for clean text', () => {
    const matches = scanText('这是一个普通的项目笔记，没有敏感信息');
    expect(matches).toHaveLength(0);
  });

  it('returns multiple matches when applicable', () => {
    const matches = scanText('张三 13912345678 身份证 110105199003078412');
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});
