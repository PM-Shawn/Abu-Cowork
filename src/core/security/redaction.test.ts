import { describe, expect, it } from 'vitest';
import { redactInlineMediaPayloads, redactSensitiveMediaText } from './redaction';
import zhCN from '../../i18n/locales/zh-CN';

describe('redactInlineMediaPayloads', () => {
  it('redacts base64 data URL payloads without redacting ordinary paths', () => {
    const dataUrls = [
      'data:image/png;base64,QQ==',
      'data:image/png;charset=utf-8;base64,QUJDRA==',
      'data:application/pdf;name=secret.pdf;base64,JVBERi0=',
      'data:;base64,QQ==',
    ];
    const plainPath = '/Users/shawn/proj/src/index.ts';
    const glob = 'glob **/*.ts';
    const sanitized = redactInlineMediaPayloads(`${plainPath} ${glob} ${dataUrls.join(' ')}`);

    expect(sanitized).toContain(plainPath);
    expect(sanitized).toContain(glob);
    for (const dataUrl of dataUrls) {
      expect(sanitized).not.toContain(dataUrl);
    }
    expect(sanitized).not.toMatch(/QQ==|QUJDRA==|JVBERi0=/);
    expect(sanitized).not.toContain('[REDACTED:path]');
    expect(sanitized.match(/\[REDACTED:base64\]/g)).toHaveLength(4);
  });
});

describe('redactSensitiveMediaText', () => {
  it.each([
    zhCN.toolResult.computer.officeEditingUnavailable,
    '输入/输出设置',
    '１/２',
    'Cafe\u0301/menu',
    'готово/ожидание',
  ])('preserves slashes within Unicode text: %s', (text) => {
    expect(redactSensitiveMediaText(text)).toBe(text);
  });

  it.each([
    ['/用户/张三/截图.png', '/用户/张三/截图.png'],
    ['图片 /用户/张三/截图.png', '/用户/张三/截图.png'],
    ['路径:/用户/张三/截图.png', '/用户/张三/截图.png'],
    ['路径：/用户/张三/截图.png', '/用户/张三/截图.png'],
    ['(/用户/张三/截图.png)', '/用户/张三/截图.png'],
    ['（/用户/张三/截图.png）', '/用户/张三/截图.png'],
    ['/Users/张三/截图.png', '/Users/张三/截图.png'],
    ['路径:/home/张三/截图.png', '/home/张三/截图.png'],
    ['(/Volumes/资料/截图.png)', '/Volumes/资料/截图.png'],
    ['C:\\用户\\张三\\截图.png', 'C:\\用户\\张三\\截图.png'],
    ['\\\\服务器\\共享\\截图.png', '\\\\服务器\\共享\\截图.png'],
    ['file:///用户/张三/截图.png', '/用户/张三/截图.png'],
    ['FILE:///用户/张三/截图.png', '/用户/张三/截图.png'],
  ])('redacts an absolute Unicode path: %s', (text, path) => {
    const sanitized = redactSensitiveMediaText(text);
    expect(sanitized).not.toContain(path);
    expect(sanitized).toContain('[REDACTED:path]');
  });

  it('preserves URL paths containing Unicode text', () => {
    const url = 'https://example.test/用户/截图.png';
    expect(redactSensitiveMediaText(url)).toBe(url);
  });

  it('redacts parameterized and empty-MIME data URLs plus angle-bracketed local paths without breaking https', () => {
    const dataUrls = [
      'data:image/png;charset=utf-8;base64,QUJDRA==',
      'data:application/pdf;name=secret.pdf;base64,JVBERi0=',
      'data:;base64,QQ==',
    ];
    const httpsUrl = 'https://example.test/assets/a.png';
    const sanitized = redactSensitiveMediaText(
      `${dataUrls.join(' ')} </Users/alice/secret.png> ${httpsUrl}`,
    );

    for (const dataUrl of dataUrls) {
      expect(sanitized).not.toContain(dataUrl);
    }
    expect(sanitized).not.toContain('/Users/alice/secret.png');
    expect(sanitized).toContain('<[REDACTED:path]>');
    expect(sanitized).toContain(httpsUrl);
    expect(sanitized).toContain('[REDACTED:base64]');
  });

  it('preserves simple HTML closing tags while redacting angle-bracketed absolute paths', () => {
    const httpsUrl = 'https://example.test/assets/a.png';
    const sanitized = redactSensitiveMediaText(`</div> </Users/alice/secret.png> ${httpsUrl}`);

    expect(sanitized).toContain('</div>');
    expect(sanitized).not.toContain('/Users/alice/secret.png');
    expect(sanitized).toContain('<[REDACTED:path]>');
    expect(sanitized).toContain(httpsUrl);
  });

  it('redacts angle-wrapped POSIX, Windows, and UNC paths containing spaces', () => {
    const secrets = [
      '</Users/Alice Smith/private image.png>',
      '<C:\\Users\\Alice Smith\\private image.png>',
      '<\\\\server\\Alice Smith\\private image.png>',
    ];
    const sanitized = redactSensitiveMediaText(secrets.join(' | '));

    for (const secret of secrets) expect(sanitized).not.toContain(secret.slice(1, -1));
    expect(sanitized.match(/<\[REDACTED:path\]>/g)).toHaveLength(3);
  });

  it('redacts wrapped, URL-safe, and quoted-parameter base64 data URLs without leaving payload tails', () => {
    const inputs = [
      'data:image/png;base64,QUJD\nRA==',
      'data:image/png;base64,QUJD-RA__',
      'data:image/png;name="secret file.png";base64,QUJDRA==',
    ];
    const sanitized = redactSensitiveMediaText(inputs.join(' | '));

    expect(sanitized).not.toMatch(/QUJD|RA==|RA__|secret file\.png/);
    expect(sanitized.match(/\[REDACTED:base64\]/g)).toHaveLength(3);
  });

  describe('local paths on macOS, Linux and Windows', () => {
    it.each([
      ['macOS home', '截图已保存到 /Users/alice/Desktop/截图.png', '/Users/alice'],
      ['macOS external disk', 'see /Volumes/Customer Files', '/Volumes/Customer'],
      ['macOS temp', 'cache /var/folders/xy/T/abu-1.png', '/var/folders'],
      ['macOS private temp', 'at /private/var/folders/xy/a.png', '/private/var'],
      ['macOS app data', '/Library/Application Support/com.abu.app/x.db', '/Library/Application'],
      ['Linux home', 'output:/home/bob/report.pdf', '/home/bob'],
      ['Linux root home', 'in /root/data.xlsx', '/root/data'],
      ['Linux temp', '(/tmp/abu-work/page.png)', '/tmp/abu-work'],
      ['Linux mounts', '/mnt/share/a.png and /media/usb/b.png', '/mnt/share'],
      ['Linux opt and srv', '/opt/app/x.png /srv/files/y.png', '/srv/files'],
      ['home shorthand', 'saved to ~/Documents/合同.pdf', '~/Documents'],
      ['Windows drive', 'C:\\Users\\Alice\\Desktop\\a.png', 'Alice'],
      ['Windows forward slashes', 'D:/工作/报表.xlsx', 'D:/工作'],
      ['UNC share', '\\\\fileserver\\财务\\a.xlsx', 'fileserver'],
      ['file URL', 'file:///opt/x/a.png', '/opt/x'],
    ])('redacts a %s path', (_label, text, secret) => {
      const sanitized = redactSensitiveMediaText(text);
      expect(sanitized).not.toContain(secret);
      expect(sanitized).toContain('[REDACTED:path]');
    });

    // Every path shape upstream/dev redacted (any root, any case) is still redacted.
    it.each([
      ['/etc/hosts', '/etc/hosts'],
      ['cat /proc/1/status', '/proc/1'],
      ['在 /data/exports/a.csv 里', '/data/exports'],
      ['/workspace/app/src/index.ts', '/workspace/app'],
      ['/users/alice/a.png', '/users/alice'],
      ['见 /api/v1/orders 接口', '/api/v1/orders'],
      ['/客户资料/合同/a.pdf', '/客户资料/合同'],
      ['(/a/b)', '/a/b'],
      ['x:/srv/a', '/srv/a'],
      ['(见)/Users/alice/a.png', '/Users/alice'],
      ['/tmp', '/tmp'],
      ['listed /tmp/ and more', '/tmp/'],
      ['wrote /report.pdf', '/report.pdf'],
      ['/年度总结.docx', '/年度总结.docx'],
    ])('redacts any root, any shape upstream redacted: %s', (text, secret) => {
      const sanitized = redactSensitiveMediaText(text);
      expect(sanitized).not.toContain(secret);
      expect(sanitized).toContain('[REDACTED:path]');
    });

    it('ends a path at Chinese punctuation, so the sentence after it stays', () => {
      expect(redactSensitiveMediaText('截图已保存到/Users/alice/a.png，请查看。')).toBe('截图已保存到[REDACTED:path]，请查看。');
      expect(redactSensitiveMediaText('文件（D:\\合同\\a.pdf）已读')).toBe('文件（[REDACTED:path]）已读');
    });
  });

  describe('text that only contains slashes', () => {
    it.each([
      '基础顾问费为人民币贰拾万元整（¥200,000.00)/年，按协议第五条第（二）款约定支付。',
      '单价 1,500.00 万元/个，包括但不限于本附件所列工具。',
      '服务费（¥30,000.00）/个，按附件一交付。',
      '增长 12%/年',
      'A/B 两版方案',
      '甲方 / 乙方',
      '/ 分隔的字段',
      '/',
      '1/2 和 3/4',
      'and/or',
      '签订日期：2026/09/28',
      '比例 1:100，C40/C50 混凝土',
      'https://example.com/Users/alice/a.png',
      'https://example.test/home/index.html',
      'http://intranet:8080/Users/list',
      '合同金额 5,000 元 /年，按季支付',
      '（¥30,000.00）/年',
      '（¥30,000.00）/year',
      '(¥30,000.00)/year',
      '[上限]/月',
      '甲方 /乙方',
      '价格/元 /年',
      '分子/分母',
      'TCP/IP',
      '</div></td>',
      '~ 约 5/6',
    ])('keeps: %s', (text) => {
      expect(redactSensitiveMediaText(text)).toBe(text);
    });
  });

  describe('tool error text', () => {
    it.each([
      ['Error: spawn C:\\Users\\Some Name\\AppData\\Local\\Programs\\soffice\\soffice.exe ENOENT', 'Error: spawn [REDACTED:path] ENOENT'],
      ["ENOENT: no such file or directory, open 'C:\\Users\\Some Name\\AppData\\Roaming\\Abu\\cache\\a b.docx'", "ENOENT: no such file or directory, open '[REDACTED:path]'"],
      ['failed reading C:\\Users\\Some Name\\Documents\\My Folder\\a.pdf: boom', 'failed reading [REDACTED:path]: boom'],
      ['Error: spawn /Users/some name/Library/Application Support/Abu/bin/pdftotext ENOENT', 'Error: spawn [REDACTED:path] ENOENT'],
      ['spawn /Users/zhang/Library/Application Support/Abu/bin/x EACCES', 'spawn [REDACTED:path] EACCES'],
    ])('leaves no part of the path of: %s', (text, expected) => {
      expect(redactSensitiveMediaText(text)).toBe(expected);
    });

    it('does not run on past a path into the next word', () => {
      expect(redactSensitiveMediaText('open C:\\Users\\bob\\a.txt and then stop')).toBe('open [REDACTED:path] and then stop');
    });
  });

  describe('names with several spaces under a user folder', () => {
    it.each([
      ['C:\\Users\\Alice\\Documents\\My Great Folder\\contract.pdf', '[REDACTED:path]'],
      ['c:\\users\\alice\\Documents\\My Great Folder\\Q3 final budget draft.xlsx', '[REDACTED:path]'],
      ['C:\\Users\\Alice Smith\\Desktop\\Client Files 2026\\Signed Contract v2.docx', '[REDACTED:path]'],
      ['/Users/alice/Documents/My Great Folder/contract.pdf', '[REDACTED:path]'],
      ['/Users/alice/Library/Application Support/My Great App/cache/a.db', '[REDACTED:path]'],
      ['/home/bob/Documents/Q3 final report v2.docx', '[REDACTED:path]'],
      ['/Users/some name/My Great Folder/x', '[REDACTED:path]'],
      ['C:\\Users\\张三\\我的 资料 文件夹\\合同.pdf', '[REDACTED:path]'],
    ])('removes the whole path: %s', (text, expected) => {
      expect(redactSensitiveMediaText(text)).toBe(expected);
    });

    it.each([
      ['Saved to C:\\Users\\Alice\\Documents\\My Great Folder\\contract.pdf and then closed the file.', 'Saved to [REDACTED:path] and then closed the file.'],
      ['Saved to /Users/alice/Documents/My Great Folder/contract.pdf. Next step is review.', 'Saved to [REDACTED:path]. Next step is review.'],
      ['Saved to /Users/alice/Documents/My Great Folder/contract.pdf, then see the other copy.', 'Saved to [REDACTED:path], then see the other copy.'],
      ['已保存到 C:\\Users\\张三\\我的 资料 文件夹\\合同.pdf，请查看。', '已保存到 [REDACTED:path]，请查看。'],
      ['Opened "/Users/alice/My Great Folder/a.pdf" for review', 'Opened "[REDACTED:path]" for review'],
      ['read /Users/alice/Documents/a.pdf and/or the notes', 'read [REDACTED:path] and/or the notes'],
      ['C:\\Users\\Alice\\a.pdf and C:\\Users\\Bob\\My Great Folder\\b.pdf', '[REDACTED:path] and [REDACTED:path]'],
      ['/Users/alice/Desktop and /Users/bob/My Great Folder/x.png ok', '[REDACTED:path] and [REDACTED:path] ok'],
      ['Error: spawn /Users/alice/bin/tool failed to start the process', 'Error: spawn [REDACTED:path] failed to start the process'],
      ['see /Users/alice/Documents for the files', 'see [REDACTED:path] for the files'],
      ['line one /Users/alice/Documents\nMy Great Folder holds it', 'line one [REDACTED:path]\nMy Great Folder holds it'],
    ])('keeps the prose after a path: %s', (text, expected) => {
      expect(redactSensitiveMediaText(text)).toBe(expected);
    });
  });
});
