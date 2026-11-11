import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { appDataDir } from '@tauri-apps/api/path';
import { lstat, readFile, stat } from '@tauri-apps/plugin-fs';
import { canonicalizeElectronPathForPolicy } from '../../utils/electronHost';
import { authorizeWorkspace, checkListPath, checkReadPath, checkWritePath, revokeWorkspace } from './pathSafety';

vi.mock('../../utils/electronHost', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/electronHost')>()),
  canonicalizeElectronPathForPolicy: vi.fn().mockResolvedValue(null),
}));

const HOME = '/Users/testuser';

/** Credential locations a model must never read, whatever folder the user has granted. */
const CLOSED_READS = [
  `${HOME}/Library/Application Support/Google/Chrome/Profile 2/Cookies`,
  `${HOME}/Library/Application Support/Google/Chrome/Default/Local Storage/leveldb/000003.log`,
  `${HOME}/Library/Application Support/Microsoft Edge/Default/Login Data`,
  `${HOME}/Library/Application Support/Firefox/Profiles/abc.default/logins.json`,
  `${HOME}/Library/Safari/History.db`,
  `${HOME}/Library/Keychains/login.keychain-db`,
  `${HOME}/Library/Application Support/1Password/data.sqlite`,
  `${HOME}/.ssh/id_ed25519`,
  `${HOME}/.gnupg/private-keys-v1.d/a.key`,
  `${HOME}/.aws/credentials`,
  `${HOME}/.config/gh/hosts.yml`,
  `${HOME}/.aliyun/config.json`,
  `${HOME}/.config/rclone/rclone.conf`,
  `${HOME}/.codex/auth.json`,
  `${HOME}/Documents/work/id_rsa`,
  `${HOME}/Documents/vault.kdbx`,
  `${HOME}/Documents/client.p12`,
  `${HOME}/Documents/work/.env`,
  `${HOME}/Documents/work/.env.production`,
  `${HOME}/.bash_history`,
  `${HOME}/.zsh_history`,
  `${HOME}/.local/share/fish/fish_history`,
  `${HOME}/.python_history`,
  `${HOME}/.config/op/config`,
  `${HOME}/.config/doctl/config.yaml`,
  `${HOME}/Library/Application Support/Slack/Cookies`,
  `${HOME}/Library/Application Support/discord/Local Storage/leveldb/000005.ldb`,
  `${HOME}/Library/Application Support/Code/Cookies`,
  `${HOME}/Library/Application Support/Cursor/User/globalStorage/state.vscdb`,
  `${HOME}/Documents/work/id_rsa_work`,
  `${HOME}/Documents/work/id_ed25519_sk`,
  `${HOME}/Documents/work/deploy_ed25519`,
  `${HOME}/Documents/work/AuthKey_ABC123.p8`,
  `${HOME}/Documents/work/release.jks`,
];

describe('pathSafety · credential locations are closed to reads', () => {
  beforeEach(() => {
    vi.mocked(canonicalizeElectronPathForPolicy).mockReset();
    vi.mocked(canonicalizeElectronPathForPolicy).mockResolvedValue(null);
    vi.mocked(lstat).mockReset();
    vi.mocked(lstat).mockResolvedValue({ isSymlink: false } as never);
    vi.mocked(stat).mockReset();
    vi.mocked(stat).mockResolvedValue({ size: 0, isDirectory: false } as never);
    vi.mocked(readFile).mockReset();
    vi.mocked(readFile).mockResolvedValue(new Uint8Array());
    authorizeWorkspace(HOME, ['read', 'write']);
  });
  afterEach(() => revokeWorkspace(HOME));

  it.each(CLOSED_READS)('refuses %s even under a granted folder', async (path) => {
    const result = await checkReadPath(path);
    expect(result.allowed).toBe(false);
    expect(result.denialKind).toBe('blocked');
    expect(result.needsPermission).toBeUndefined();
  });

  it('matches without regard to case, as the filesystem does', async () => {
    expect((await checkReadPath(`${HOME}/.SSH/ID_RSA`)).denialKind).toBe('blocked');
    expect((await checkReadPath(`${HOME}/LIBRARY/application support/google/CHROME/Default/Cookies`)).denialKind).toBe('blocked');
  });

  it('keeps the copies made for sharing readable', async () => {
    for (const name of ['.env.example', '.env.sample', '.env.template']) {
      const result = await checkReadPath(`${HOME}/Documents/work/${name}`);
      expect(result.denialKind).toBeUndefined();
    }
  });

  it('closes a .pem that holds a private key and leaves a certificate readable', async () => {
    const key = new TextEncoder().encode('-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----');
    vi.mocked(readFile).mockResolvedValueOnce(key);
    const closed = await checkReadPath(`${HOME}/Documents/work/deploy.pem`);
    expect(closed.allowed).toBe(false);
    expect(closed.denialKind).toBe('blocked');

    const cert = new TextEncoder().encode('-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----');
    vi.mocked(readFile).mockResolvedValueOnce(cert);
    expect((await checkReadPath(`${HOME}/Documents/work/site.pem`)).allowed).toBe(true);
  });

  it('closes a WireGuard config by its PrivateKey line', async () => {
    vi.mocked(readFile).mockResolvedValueOnce(new TextEncoder().encode('[Interface]\nPrivateKey = abc=\n'));
    expect((await checkReadPath(`${HOME}/Documents/wg0.conf`)).denialKind).toBe('blocked');
  });

  it('closes a key-like file whose text cannot be read to tell', async () => {
    vi.mocked(readFile).mockRejectedValueOnce(new Error('EACCES'));
    expect((await checkReadPath(`${HOME}/Documents/x.key`)).denialKind).toBe('blocked');
  });

  it('closes the app\'s own data folders to reads and listings', async () => {
    const appData = `${HOME}/Library/Application Support/Abu`;
    for (const path of [`${appData}/secrets.json`, `${appData}/Cookies`]) {
      expect((await checkReadPath(path)).denialKind).toBe('blocked');
    }
    expect((await checkListPath(appData)).denialKind).toBe('blocked');
  });

  it('keeps a public key and key-like words in ordinary names readable', async () => {
    for (const name of ['id_rsa.pub', 'id_ed25519.pub', 'id_card.png', 'rsa notes.txt']) {
      const result = await checkReadPath(`${HOME}/Documents/work/${name}`);
      expect(result.denialKind, name).toBeUndefined();
    }
  });

  it('finds a private key in a large .pem bundle past the first 64 KB', async () => {
    const filler = '-----BEGIN CERTIFICATE-----\n' + 'A'.repeat(100_000) + '\n-----END CERTIFICATE-----\n';
    const bundle = new TextEncoder().encode(filler + '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n');
    vi.mocked(stat).mockResolvedValueOnce({ size: bundle.length, isDirectory: false } as never);
    vi.mocked(readFile).mockResolvedValueOnce(bundle);
    expect((await checkReadPath(`${HOME}/Documents/work/chain.pem`)).denialKind).toBe('blocked');
  });

  it('closes an extension-less file whose text is a private key', async () => {
    vi.mocked(stat).mockResolvedValueOnce({ size: 400, isDirectory: false } as never);
    vi.mocked(readFile).mockResolvedValueOnce(new TextEncoder().encode('-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n'));
    expect((await checkReadPath(`${HOME}/Documents/work/deploy_key`)).denialKind).toBe('blocked');
  });

  it('closes a larger-than-scannable .pem and leaves a larger-than-scannable Keynote .key alone', async () => {
    vi.mocked(stat).mockResolvedValueOnce({ size: 200_000_000, isDirectory: false } as never);
    expect((await checkReadPath(`${HOME}/Documents/work/huge.pem`)).denialKind).toBe('blocked');
    vi.mocked(stat).mockResolvedValueOnce({ size: 200_000_000, isDirectory: false } as never);
    expect((await checkReadPath(`${HOME}/Documents/work/talk.key`)).allowed).toBe(true);
  });

  it('closes a closed location reached through a link', async () => {
    vi.mocked(canonicalizeElectronPathForPolicy).mockResolvedValue(`${HOME}/.ssh/id_rsa`);
    const result = await checkReadPath(`${HOME}/Documents/notes.txt`);
    expect(result.denialKind).toBe('blocked');
  });

  it('keeps ordinary files readable', async () => {
    expect((await checkReadPath(`${HOME}/Documents/report.docx`)).allowed).toBe(true);
    expect((await checkReadPath(`${HOME}/Documents/keynotes.txt`)).allowed).toBe(true);
  });
});

describe('pathSafety · start-at-sign-in locations are closed to writes', () => {
  beforeEach(() => {
    vi.mocked(canonicalizeElectronPathForPolicy).mockReset();
    vi.mocked(canonicalizeElectronPathForPolicy).mockResolvedValue(null);
    vi.mocked(lstat).mockReset();
    vi.mocked(lstat).mockResolvedValue({ isSymlink: false } as never);
    vi.mocked(appDataDir).mockResolvedValue(`${HOME}/Library/Application Support/Abu`);
    authorizeWorkspace(HOME, ['read', 'write']);
  });
  afterEach(() => revokeWorkspace(HOME));

  it.each([
    `${HOME}/Library/LaunchAgents/com.example.job.plist`,
    `${HOME}/Library/LaunchDaemons/x.plist`,
    `${HOME}/.config/fish/config.fish`,
    `${HOME}/.zlogin`,
  ])('refuses a write to %s in every case', async (path) => {
    const result = await checkWritePath(path);
    expect(result.allowed).toBe(false);
    expect(result.needsPermission).toBeUndefined();
    expect(result.denialKind).toBe('blocked');
  });

  it('refuses a write to a PowerShell profile wherever Documents is', async () => {
    const result = await checkWritePath('/Volumes/Cloud/Documents/PowerShell/Microsoft.PowerShell_profile.ps1');
    expect(result.denialKind).toBe('blocked');
  });

  it('asks instead of refusing when the write is a delete', async () => {
    const result = await checkWritePath(`${HOME}/Library/LaunchAgents/com.example.job.plist`, undefined, { purpose: 'delete' });
    expect(result.denialKind).toBeUndefined();
  });
});
