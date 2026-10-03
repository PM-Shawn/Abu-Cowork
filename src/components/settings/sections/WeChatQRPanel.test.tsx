// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initLanguage } from '@/i18n';
import WeChatQRPanel from './WeChatQRPanel';

// Made-up values. The token a scan returns goes to the caller and never onto the page.
const CREDENTIALS = { botToken: 'wechat-token-not-real', baseurl: 'https://ilink.example.test', ilinkBotId: 'bot-not-real' };
const QR = { qrcode: 'qr-not-real', qrcode_img_content: 'https://example.test/not-a-real-binding' };

const wechat = vi.hoisted(() => ({ getQR: vi.fn(), poll: vi.fn() }));
vi.mock('@/core/im/adapters/wechat', () => ({
  getWeChatQRCode: wechat.getQR,
  pollWeChatQRStatus: wechat.poll,
}));
const qrcode = vi.hoisted(() => ({ toDataURL: vi.fn() }));
vi.mock('qrcode', () => ({ default: { toDataURL: qrcode.toDataURL } }));

const onBound = vi.fn();
const spinners = () => document.querySelectorAll('[data-ds-spinner]').length;
// Lets the promises that are already settled reach the page.
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

// Up to the point where the code is on screen and the panel waits for the phone.
async function showCode() {
  const view = render(<WeChatQRPanel onBound={onBound} />);
  fireEvent.click(screen.getByRole('button', { name: '获取二维码' }));
  await flush();
  return view;
}

function readableOutsideFields(): string {
  const attributes = [...document.querySelectorAll('*')].flatMap((element) => (
    [...element.attributes]
      .filter((attribute) => attribute.name === 'title' || attribute.name.startsWith('aria-') || attribute.name.startsWith('data-'))
      .map((attribute) => `${attribute.name}=${attribute.value}`)
  ));
  return [document.body.textContent ?? '', ...attributes].join('\n');
}

describe('WeChatQRPanel', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    vi.useFakeTimers();
    onBound.mockReset();
    wechat.getQR.mockReset().mockResolvedValue(QR);
    wechat.poll.mockReset().mockResolvedValue({ status: 'waiting' });
    qrcode.toDataURL.mockReset().mockResolvedValue('data:image/png;base64,AAAA');
  });
  afterEach(() => { vi.useRealTimers(); });

  it('starts with the explanation and one button, which is not the filled one of its place', () => {
    render(<WeChatQRPanel onBound={onBound} />);
    expect(screen.getByText('使用微信扫码，授权阿布接收并回复消息（仅支持私聊）')).toBeInTheDocument();
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveTextContent('获取二维码');
    expect(buttons[0]).toHaveClass('bg-fill');
    expect(buttons[0]).not.toHaveClass('bg-emphasis');
    expect(spinners()).toBe(0);
    expect(wechat.getQR).not.toHaveBeenCalled();
  });

  it('asks for a code once when the button is pressed, and says so with exactly one spinner until it arrives', async () => {
    wechat.getQR.mockReturnValue(new Promise(() => undefined));
    render(<WeChatQRPanel onBound={onBound} />);
    fireEvent.click(screen.getByRole('button', { name: '获取二维码' }));
    await flush();

    expect(wechat.getQR).toHaveBeenCalledExactlyOnceWith();
    expect(spinners()).toBe(1);
    expect(screen.getByRole('status')).toHaveTextContent('获取二维码…');
    expect(screen.queryByRole('button')).toBeNull();
    expect(wechat.poll).not.toHaveBeenCalled();
  });

  it('shows the code and counts down while it waits for the phone, with nothing spinning', async () => {
    await showCode();

    expect(qrcode.toDataURL).toHaveBeenCalledWith(QR.qrcode_img_content, { width: 320, margin: 1, errorCorrectionLevel: 'M' });
    expect(screen.getByAltText('WeChat QR Code')).toHaveClass('bg-page-canvas');
    expect(screen.getByText('请用微信扫描二维码')).toBeInTheDocument();
    expect(screen.getByText('二维码将在 120 秒后过期')).toBeInTheDocument();
    expect(spinners()).toBe(0);
    expect(screen.queryByRole('button')).toBeNull();

    await advance(1000);
    expect(screen.getByText('二维码将在 119 秒后过期')).toBeInTheDocument();
    expect(wechat.poll).not.toHaveBeenCalled();
    await advance(1000);
    expect(wechat.poll).toHaveBeenCalledExactlyOnceWith('qr-not-real');
    expect(spinners()).toBe(0);
  });

  it('says the code is being drawn with one spinner until the image exists', async () => {
    qrcode.toDataURL.mockReturnValue(new Promise(() => undefined));
    await showCode();
    expect(screen.queryByAltText('WeChat QR Code')).toBeNull();
    expect(spinners()).toBe(1);
    expect(screen.getByRole('status')).toHaveTextContent('获取二维码…');
  });

  it('marks the code as scanned with one success shape, and stops showing the countdown', async () => {
    wechat.poll.mockResolvedValue({ status: 'scanned' });
    await showCode();
    await advance(2000);

    expect(screen.getByText('已扫码，请在手机上确认')).toBeInTheDocument();
    expect(screen.queryByText('请用微信扫描二维码')).toBeNull();
    expect(screen.queryByText(/秒后过期/)).toBeNull();
    expect(document.querySelectorAll('.text-success')).toHaveLength(1);
    expect(screen.getByAltText('WeChat QR Code')).toHaveClass('opacity-30');
    expect(spinners()).toBe(0);
    expect(onBound).not.toHaveBeenCalled();
  });

  it('hands the credentials over once when the phone confirms, and keeps the token off the page', async () => {
    wechat.poll.mockResolvedValue({ status: 'confirmed', credentials: CREDENTIALS });
    await showCode();
    await advance(2000);

    expect(onBound).toHaveBeenCalledExactlyOnceWith(CREDENTIALS);
    expect(screen.getByText('绑定成功')).toHaveClass('text-success');
    expect(screen.queryByAltText('WeChat QR Code')).toBeNull();
    expect(spinners()).toBe(0);
    expect(readableOutsideFields()).not.toContain(CREDENTIALS.botToken);

    await advance(10_000);
    expect(onBound).toHaveBeenCalledOnce();
    expect(wechat.poll).toHaveBeenCalledOnce();
  });

  it('says the code has expired when WeChat says so, and fetches a new one on request', async () => {
    wechat.poll.mockResolvedValue({ status: 'expired' });
    await showCode();
    await advance(2000);

    expect(screen.getByText('二维码已过期')).toBeInTheDocument();
    expect(screen.queryByAltText('WeChat QR Code')).toBeNull();
    const retry = screen.getByRole('button', { name: '重新获取' });
    expect(retry).not.toHaveClass('bg-emphasis');
    await advance(10_000);
    expect(wechat.poll).toHaveBeenCalledOnce();

    wechat.poll.mockResolvedValue({ status: 'waiting' });
    fireEvent.click(retry);
    await flush();
    expect(wechat.getQR).toHaveBeenCalledTimes(2);
    expect(screen.getByText('请用微信扫描二维码')).toBeInTheDocument();
  });

  it('says the code has expired when its two minutes run out', async () => {
    await showCode();
    await advance(119_000);
    expect(screen.getByText('二维码将在 1 秒后过期')).toBeInTheDocument();
    await advance(1000);

    expect(screen.getByText('二维码已过期')).toBeInTheDocument();
    const polls = wechat.poll.mock.calls.length;
    await advance(10_000);
    expect(wechat.poll).toHaveBeenCalledTimes(polls);
  });

  it('shows why no code could be fetched with one danger shape, and tries again on request', async () => {
    wechat.getQR.mockRejectedValueOnce(new Error('get_bot_qrcode HTTP 500'));
    render(<WeChatQRPanel onBound={onBound} />);
    fireEvent.click(screen.getByRole('button', { name: '获取二维码' }));
    await flush();

    expect(screen.getByText('get_bot_qrcode HTTP 500')).toHaveClass('text-danger');
    expect(document.querySelectorAll('svg.text-danger')).toHaveLength(1);
    expect(spinners()).toBe(0);
    expect(wechat.poll).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '重新获取' }));
    await flush();
    expect(wechat.getQR).toHaveBeenCalledTimes(2);
    expect(screen.getByText('请用微信扫描二维码')).toBeInTheDocument();
  });

  it('keeps waiting and asks again when one status request fails', async () => {
    wechat.poll.mockRejectedValueOnce(new Error('network'));
    await showCode();
    await advance(2000);
    expect(screen.getByText('请用微信扫描二维码')).toBeInTheDocument();
    await advance(2000);
    expect(wechat.poll).toHaveBeenCalledTimes(2);
    expect(screen.getByText('请用微信扫描二维码')).toBeInTheDocument();
  });

  it('asks WeChat nothing more once the panel has left the page', async () => {
    const view = await showCode();
    await advance(2000);
    expect(wechat.poll).toHaveBeenCalledOnce();

    view.unmount();
    await advance(20_000);
    expect(wechat.poll).toHaveBeenCalledOnce();
    expect(onBound).not.toHaveBeenCalled();
  });
});
