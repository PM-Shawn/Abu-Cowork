import { describe, expect, it } from 'vitest';
import { isPaymentPagePath, isPaymentPageTitle } from './governmentPaymentPage';

describe('governmentPaymentPage', () => {
  it.each([
    'https://etax.chinatax.gov.cn/payment/tax',
    'https://www.example.gov.cn/online/pay',
    'https://www.example.gov.cn/online-payments/new',
    'https://si.example.gov.cn/jiaofei/index.html',
    'https://si.example.gov.cn/%E7%BC%B4%E8%B4%B9/index',
    'https://si.example.gov.cn/社保缴费/x',
  ])('reads a payment path in %s', (url) => {
    expect(isPaymentPagePath(url)).toBe(true);
  });

  it.each([
    'https://www.gsxt.gov.cn/index.html',
    'https://www.example.gov.cn/paystub-help',
    'https://www.example.gov.cn/search?q=payment',
    'https://www.example.gov.cn/repayments',
    null,
    'not a url',
  ])('does not read a payment page in %s', (url) => {
    expect(isPaymentPagePath(url)).toBe(false);
  });

  it.each(['社保费缴费', '税费缴纳 - 电子税务局', '在线支付', 'Pay your tax online', 'Payment'])('reads the title %s', (title) => {
    expect(isPaymentPageTitle(title)).toBe(true);
  });

  it.each(['国家企业信用信息公示系统', 'Paypoint locations', '', undefined])('does not read the title %s', (title) => {
    expect(isPaymentPageTitle(title)).toBe(false);
  });
});

describe('governmentPaymentPage · more cases', () => {
  it('does not take a word that merely contains pay for a payment page', () => {
    expect(isPaymentPagePath('https://x.gov.cn/payroll/list')).toBe(false);
    expect(isPaymentPagePath('https://x.gov.cn/display/pay-per-view-news')).toBe(true);
    expect(isPaymentPageTitle('Payroll report')).toBe(false);
    expect(isPaymentPageTitle('Pay your fine')).toBe(true);
  });

  // Documented behavior, not a defect: the title only ever tightens. A query page titled
  // 「缴费记录查询」 counts as a payment page, so each click on it asks (and the task grant of
  // the government site does not cover it). Acceptable: asking more is the safe side.
  it('reads a query page titled with 缴费 as a payment page', () => {
    expect(isPaymentPageTitle('缴费记录查询 - 国家税务总局电子税务局')).toBe(true);
    expect(isPaymentPagePath('https://etax.example.gov.cn/query/records')).toBe(false);
  });

  it('reads the decoded path, a lone percent sign and an unparseable address without throwing', () => {
    expect(isPaymentPagePath('https://x.gov.cn/%E7%BC%B4%E8%B4%B9%E4%B8%AD%E5%BF%83')).toBe(true);
    expect(isPaymentPagePath('https://x.gov.cn/100%/pay')).toBe(true);
    expect(isPaymentPagePath('not a url')).toBe(false);
    expect(isPaymentPagePath(null)).toBe(false);
    expect(isPaymentPageTitle(undefined)).toBe(false);
  });

  // Known gap (should-fix, not a defect of the rule as written): only the path is read, so a
  // single-page app that keeps its route in the fragment (`/#/pay/confirm`, common on provincial
  // tax and social-insurance sites) or in the query (`?action=pay`) is not seen as a payment page
  // unless its title says so.
  it('reads a payment route kept in the fragment or the query', () => {
    expect(isPaymentPagePath('https://etax.example.gov.cn/index.html#/pay/confirm')).toBe(true);
    expect(isPaymentPagePath('https://etax.example.gov.cn/app?action=pay')).toBe(true);
  });
});
