'use strict';

/**
 * Fetch a plugin package from a remote git source, in the privileged main
 * process (the renderer never touches shell/network).
 *
 * Design and guardrails come from `docs/reference-codex-remote-fetch-firsthand.md`
 * (firsthand reverse-engineering of Codex) plus this project's Batch-1 security
 * review. Two things we do that Codex does NOT:
 *   - assert the checked-out HEAD equals the marketplace-declared sha
 *     (Codex is trust-on-fetch: it records the sha but never compares);
 *   - scrub the git environment of hijack vectors before every spawn.
 *
 * Clone shape: `--filter=blob:none --no-checkout` (blobless partial clone),
 * NOT `--depth 1` (shallow). Shallow can only reach a branch tip, so checking
 * out an arbitrary historical sha — which sha-pinning requires — fails on a
 * shallow clone. Blobless fetches full history metadata cheaply and can check
 * out any commit.
 */

const { spawn } = require('node:child_process');

class PluginGitError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'PluginGitError';
    this.code = code || 'plugin_git_error';
  }
}

/**
 * Throw unless `url` is a plain `https://` git URL safe to pass as a spawn
 * argument. Rejects other schemes, anything git could read as an option, and
 * anything with whitespace/control characters.
 */
function assertSafeGitUrl(url) {
  if (typeof url !== 'string' || url.length === 0) {
    throw new PluginGitError('git url must be a non-empty string', 'bad_url');
  }
  // No leading/trailing whitespace, no control chars or newlines anywhere.
  if (url.trim() !== url || /[\x00-\x1f\x7f]/.test(url)) {
    throw new PluginGitError(`git url has unsafe characters: ${JSON.stringify(url)}`, 'bad_url');
  }
  // A value git would parse as a flag, even as an array element.
  if (url.startsWith('-')) {
    throw new PluginGitError(`git url must not start with "-": ${url}`, 'bad_url');
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new PluginGitError(`git url is not a valid URL: ${url}`, 'bad_url');
  }
  if (parsed.protocol !== 'https:') {
    throw new PluginGitError(`git url must be https:// (got ${parsed.protocol})`, 'bad_scheme');
  }
  return url;
}

/**
 * Throw unless `sha` is a bare hex commit id. sha reaches git argv (checkout);
 * unlike the url it had no `--` guard, so a value like `--upload-pack=…` would
 * be read as an option. A hex-only shape closes that.
 */
function assertSafeSha(sha) {
  if (typeof sha !== 'string' || !/^[0-9a-f]{4,64}$/.test(sha)) {
    throw new PluginGitError(`unsafe git sha: ${JSON.stringify(sha)}`, 'bad_sha');
  }
  return sha;
}

/**
 * Throw unless `p` is a plain relative POSIX path fit both for
 * `sparse-checkout` argv and for hoisting inside the staging dir: non-empty,
 * not option-shaped (`-…`), not absolute, no `\` / `:` / control characters
 * (newline and NUL included), no glob / negation / comment characters
 * (`* ? [ ] ! #` — a marketplace `path` is a literal directory, never a
 * sparse-checkout pattern), no empty / `.` / `..` segment, and no `.git`
 * segment anywhere (case-insensitively — the checkout is case-preserving on
 * macOS/Windows, so `.GIT` would land on the object store). Runs BEFORE any
 * git work so a bad path never reaches argv or the checkout; `hoistSubdir`
 * re-runs it as defence in depth.
 */
function assertSafeSubdirPath(p) {
  const bad = (why) =>
    new PluginGitError(`unsafe git-subdir path (${why}): ${JSON.stringify(p)}`, 'bad_args');
  if (typeof p !== 'string' || p.length === 0) throw bad('empty');
  if (p.startsWith('-')) throw bad('option-shaped');
  if (p.startsWith('/')) throw bad('absolute');
  if (p.includes('\\') || p.includes(':')) throw bad('forbidden character');
  if (/[*?[\]!#]/.test(p)) throw bad('pattern character');
  for (let i = 0; i < p.length; i += 1) {
    const c = p.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) throw bad('control character');
  }
  const segs = p.split('/');
  if (segs.some((seg) => seg === '' || seg === '.' || seg === '..')) throw bad('empty or dot segment');
  if (segs.some((seg) => seg.toLowerCase() === '.git')) throw bad('.git segment');
  return p;
}

/** argv for the blobless, no-checkout clone. url + dest are the last two. */
function buildCloneArgs(url, dest) {
  return ['clone', '--filter=blob:none', '--no-checkout', '--', url, dest];
}

/** argv restricting the working tree to one subdirectory (git-subdir source). */
function buildSparseArgs(dest, subdir) {
  return ['-C', dest, 'sparse-checkout', 'set', '--no-cone', '--', subdir];
}

/** argv checking out an exact ref/sha in detached HEAD. */
function buildCheckoutArgs(dest, ref) {
  return ['-C', dest, 'checkout', '--detach', ref];
}

/** argv reading the resolved HEAD sha, for the post-checkout assertion. */
function buildRevParseArgs(dest) {
  return ['-C', dest, 'rev-parse', 'HEAD'];
}

/**
 * A git environment with prompts disabled and every hijack vector removed.
 * Returns a fresh object; the input is not mutated.
 */
const GIT_HIJACK_VARS = [
  'GIT_DIR',
  'GIT_CONFIG',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_OBJECT_DIRECTORY',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_ASKPASS',
  'GIT_PROXY_COMMAND',
  'GIT_EXTERNAL_DIFF',
  // The env-based config-injection family: GIT_CONFIG_COUNT gates how many
  // GIT_CONFIG_KEY_<n>/GIT_CONFIG_VALUE_<n> pairs git reads, and those can set
  // core.sshCommand / core.hooksPath / http.*.proxy — arbitrary code exec.
  'GIT_CONFIG_COUNT',
];

/** Numbered config-injection vars (GIT_CONFIG_KEY_0, …) — matched by pattern. */
const GIT_CONFIG_INJECT_RE = /^GIT_CONFIG_(KEY|VALUE)_\d+$/;

function cleanGitEnv(baseEnv) {
  const env = { ...baseEnv };
  for (const key of GIT_HIJACK_VARS) delete env[key];
  // Strip the whole numbered config-injection family, whatever the index.
  for (const key of Object.keys(env)) {
    if (GIT_CONFIG_INJECT_RE.test(key)) delete env[key];
  }
  env.GIT_TERMINAL_PROMPT = '0'; // never block on an interactive credential prompt
  env.GIT_OPTIONAL_LOCKS = '0';
  return env;
}

/** Base `git -c ...` hardening flags prepended to every invocation. */
const GIT_HARDENING = ['-c', 'safe.bareRepository=explicit', '-c', 'protocol.ext.allow=never'];

/**
 * Run one git invocation with a wall-clock timeout, captured stdout, and the
 * scrubbed environment. Rejects with a PluginGitError on non-zero exit,
 * timeout, or spawn failure.
 */
function runGit(args, { spawnImpl = spawn, env, timeoutMs, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl('git', [...GIT_HARDENING, ...args], {
      env: cleanGitEnv(env ?? process.env),
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, timeoutMs)
      : null;

    child.stdout?.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    child.once('error', (err) => {
      if (timer) clearTimeout(timer);
      // ENOENT = no git binary on PATH — the one spawn failure the archive
      // fallback may recover from. Every other spawn error keeps its code.
      const code = err && err.code === 'ENOENT' ? 'git_missing' : 'spawn_failed';
      reject(new PluginGitError(`git failed to spawn: ${err.message}`, code));
    });
    child.once('close', (exitCode) => {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        reject(new PluginGitError(`git timed out after ${timeoutMs}ms`, 'timeout'));
        return;
      }
      if (exitCode !== 0) {
        // Only the clone step is fallback-eligible (network/transport trouble);
        // a failing checkout/rev-parse means the sha is wrong, which the
        // archive path could not fix. Message shape is unchanged either way.
        const code = args[0] === 'clone' ? 'clone_failed' : 'git_exit';
        reject(new PluginGitError(`git exited ${exitCode}: ${stderr.trim()}`, code));
        return;
      }
      resolve(stdout);
    });
  });
}

// ── GitHub archive fallback (P1-4) ───────────────────────────────────────────
// When git is absent (spawn ENOENT) or the clone step fails, a plain
// `https://github.com/<owner>/<repo>` source can still be fetched as the
// codeload zip of the pinned sha. GitHub names the archive's single root folder
// `<repo>-<sha>` — with no git to rev-parse, that folder name is the only
// integrity assertion available (the same guarantee level Codex offers; weaker
// than the git path, so the dispatch result reports `via: 'archive'`).

const GITHUB_REPO_RE = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;
const ARCHIVE_FALLBACK_CODES = new Set(['git_missing', 'clone_failed']);
/** The fallback needs a full 40-hex sha: codeload names the root folder with it. */
const FULL_SHA_RE = /^[0-9a-f]{40}$/;
/** Hosts a codeload redirect may land on. Anything else aborts the download. */
const ARCHIVE_REDIRECT_HOSTS = new Set(['github.com', 'codeload.github.com', 'objects.githubusercontent.com']);
const ARCHIVE_MAX_REDIRECTS = 3;
const ARCHIVE_TIMEOUT_MS = 60_000;
/** Cap on the compressed download (network bytes). */
const ARCHIVE_MAX_BYTES = 50 * 1024 * 1024;
/** Cap on the total *unpacked* size — a zip bomb passes the network cap. */
const ARCHIVE_MAX_UNPACKED_BYTES = 200 * 1024 * 1024;

/** `{ url, repo }` for a github.com repo url, or null when not eligible. */
function githubArchiveUrl(url, sha) {
  const m = GITHUB_REPO_RE.exec(url);
  if (!m) return null;
  return { url: `https://codeload.github.com/${m[1]}/${m[2]}/zip/${sha}`, repo: m[2] };
}

/** True only for an `https://` url on one of the GitHub archive hosts. */
function isAllowedArchiveUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === 'https:' && ARCHIVE_REDIRECT_HOSTS.has(parsed.hostname);
}

/**
 * GET `url` over https into a Buffer. Follows at most ARCHIVE_MAX_REDIRECTS
 * redirects, each of which must stay on https and on an allowed GitHub host;
 * rejects on any non-200, on a body over `maxBytes`, on idle or wall-clock
 * timeout. Every failure is a PluginGitError with code `archive_failed`.
 *
 * `opts.getImpl` (default `https.get`) is a test seam so the redirect policy
 * is exercised against scripted responses, never the network.
 */
function downloadArchiveHttps(url, opts = {}) {
  const {
    timeoutMs = ARCHIVE_TIMEOUT_MS,
    maxBytes = ARCHIVE_MAX_BYTES,
    redirectsLeft = ARCHIVE_MAX_REDIRECTS,
    getImpl,
  } = opts;
  const get = getImpl || require('node:https').get;
  if (!isAllowedArchiveUrl(url)) {
    return Promise.reject(new PluginGitError(`archive url not allowed: ${url}`, 'archive_failed'));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let wallClock = null;
    // Single settle point: whichever of end/error/redirect/limit fires first
    // wins, and the wall-clock timer is always released with it.
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (wallClock) clearTimeout(wallClock);
      fn(value);
    };
    const fail = (message) => finish(reject, new PluginGitError(message, 'archive_failed'));
    const req = get(url, { headers: { 'user-agent': 'abu-plugin-fetch' } }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return fail('archive redirect limit exceeded');
        let next;
        try {
          next = new URL(res.headers.location, url).toString();
        } catch {
          return fail(`archive redirect is not a valid url: ${res.headers.location}`);
        }
        if (!isAllowedArchiveUrl(next)) return fail(`archive redirect not allowed: ${next}`);
        return downloadArchiveHttps(next, { timeoutMs, maxBytes, redirectsLeft: redirectsLeft - 1, getImpl }).then(
          (b) => finish(resolve, b),
          (e) => finish(reject, e),
        );
      }
      if (status !== 200) {
        res.resume();
        return fail(`archive HTTP ${status}`);
      }
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes) {
        req.destroy();
        return fail(`archive too large (${declared} bytes declared)`);
      }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) {
          req.destroy();
          fail(`archive too large (over ${maxBytes} bytes)`);
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => finish(resolve, Buffer.concat(chunks)));
      res.on('error', (e) => fail(`archive download failed: ${e.message}`));
    });
    // Idle timeout (no bytes for timeoutMs) and a wall-clock ceiling mirroring
    // the bounded git invocations — a trickling response must not hang forever.
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`idle for ${timeoutMs}ms`)));
    wallClock = setTimeout(() => req.destroy(new Error(`exceeded ${timeoutMs * 2}ms`)), timeoutMs * 2);
    if (typeof wallClock.unref === 'function') wallClock.unref(); // never pins the process
    req.on('error', (e) => fail(`archive download failed: ${e.message}`));
  });
}

/**
 * Unpack a GitHub codeload zip into `tmpDir`. Every entry must live under the
 * single root `<repo>-<sha>/` (else `sha_mismatch` — the archive is not the
 * pinned commit). For `git-subdir` sources only entries under `source.path`
 * are written (mirroring sparse-checkout). Entry paths are validated so no
 * `..`, absolute, or backslash-bearing name can escape `tmpDir`, and total
 * unpacked bytes are capped independently of the download cap.
 *
 * `fs`/`path` are the module-level requires declared in the IPC section below;
 * this runs at call time, well after module evaluation.
 */
function extractArchive(zipBytes, source, tmpDir, repo, { maxUnpackedBytes = ARCHIVE_MAX_UNPACKED_BYTES } = {}) {
  const fflate = require('fflate');
  const unsafe = (name) => new PluginGitError(`unsafe path in archive: ${JSON.stringify(name)}`, 'bad_args');
  // Anything fflate throws (corrupt zip, unsupported method, …) surfaces under
  // the one stable code; our own size-cap error passes through untouched.
  let entries;
  let unpacked = 0;
  try {
    entries = fflate.unzipSync(new Uint8Array(zipBytes), {
      filter: (info) => {
        unpacked += info.originalSize || 0;
        if (unpacked > maxUnpackedBytes) {
          throw new PluginGitError(`archive unpacks to more than ${maxUnpackedBytes} bytes`, 'archive_failed');
        }
        return true;
      },
    });
  } catch (err) {
    if (err instanceof PluginGitError) throw err;
    throw new PluginGitError(`archive could not be unpacked: ${err && err.message ? err.message : String(err)}`, 'archive_failed');
  }
  const expectedRoot = `${repo}-${source.sha}/`;
  const names = Object.keys(entries);
  if (names.length === 0 || !names.every((n) => n.startsWith(expectedRoot))) {
    throw new PluginGitError(`archive root is not ${expectedRoot}`, 'sha_mismatch');
  }
  const subdir = source.kind === 'git-subdir' ? source.path.replace(/^\/+|\/+$/g, '') + '/' : '';
  const root = path.resolve(tmpDir);

  // Pass 1 — validate every entry before writing any, so a bad entry never
  // leaves a partially populated staging dir behind. Rejected: NUL anywhere,
  // empty / `.` / `..` segments, backslashes, and `:` (Windows drive / ADS),
  // plus a resolved-path containment check as the backstop.
  const plan = [];
  for (const name of names) {
    if (name.includes('\0')) throw unsafe(name);
    if (name.endsWith('/')) continue; // directory entry
    const rel = name.slice(expectedRoot.length);
    if (subdir && !rel.startsWith(subdir)) continue;
    const out = rel.slice(subdir.length);
    const segs = out.split('/');
    if (segs.some((seg) => seg === '' || seg === '.' || seg === '..' || /[\\:]/.test(seg))) throw unsafe(name);
    const dest = path.resolve(root, out);
    if (!dest.startsWith(root + path.sep)) throw unsafe(name);
    plan.push({ name, dest });
  }
  if (subdir && plan.length === 0) {
    throw new PluginGitError(`archive has no files under ${source.path}`, 'archive_failed');
  }

  // Pass 2 — write. Filesystem failures also surface under the stable code.
  try {
    for (const { name, dest } of plan) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, entries[name]);
    }
  } catch (err) {
    if (err instanceof PluginGitError) throw err;
    throw new PluginGitError(`archive could not be written: ${err && err.message ? err.message : String(err)}`, 'archive_failed');
  }
}

/**
 * Hoist `<tmpDir>/<subdir>/*` to `<tmpDir>` after a sparse checkout, so a
 * `git-subdir` package has the same shape as a `url` package (and as the
 * archive fallback, which already writes the subdir contents at the root):
 * the renderer installer reads `<destDir>/.abu-plugin/plugin.json` and never
 * knows the marketplace path. The `.git` directory stays where it is — the
 * dispatch strips it after the move.
 *
 * The subdir is moved aside under a fresh name first so an entry that shares
 * a name with the wrapper (e.g. `pkgs/p/pkgs`) cannot collide; the wrapper is
 * then removed and each entry renamed to the root. A symlinked subdir is
 * refused (it could point outside the staging tree), as is any entry whose
 * root destination already exists.
 *
 * `fs`/`path` are the module-level requires declared in the IPC section below.
 */
function hoistSubdir(tmpDir, subdir) {
  const clean = assertSafeSubdirPath(subdir);
  const root = path.resolve(tmpDir);
  const segs = clean.split('/');
  const src = path.resolve(root, clean);
  if (!src.startsWith(root + path.sep)) {
    throw new PluginGitError(`unsafe git-subdir path: ${subdir}`, 'bad_args');
  }
  let st;
  try {
    st = fs.lstatSync(src);
  } catch {
    throw new PluginGitError(`git-subdir path not found in repo: ${subdir}`, 'subdir_missing');
  }
  if (!st.isDirectory()) {
    // A symlinked (or file) final component is refused outright.
    throw new PluginGitError(`git-subdir path is not a directory: ${subdir}`, 'subdir_missing');
  }
  // Physical containment. The lexical check above cannot see a symlink git
  // checked out in an intermediate segment (`pkgs -> /elsewhere`); the
  // resolved directory must live inside the resolved staging root, otherwise
  // the rename below would move a directory that is not ours.
  const realRoot = fs.realpathSync(root);
  const realSrc = fs.realpathSync(src);
  if (!realSrc.startsWith(realRoot + path.sep)) {
    throw new PluginGitError('subdir escapes the checkout', 'bad_args');
  }
  const aside = path.join(root, `.abu-hoist-${process.pid}-${Date.now().toString(36)}`);
  // Filesystem failures below surface as `git_exit`: the hoist is the last
  // step of the git checkout, and that is the code the rest of the git path
  // uses for a failed step, so callers see one stable set of codes.
  try {
    fs.renameSync(src, aside);
    // Everything under the wrapper's first segment was only ever checkout scaffolding.
    fs.rmSync(path.join(root, segs[0]), { recursive: true, force: true });
    for (const name of fs.readdirSync(aside)) {
      const to = path.join(root, name);
      if (fs.existsSync(to)) {
        throw new PluginGitError(`git-subdir entry collides with repo root: ${name}`, 'bad_args');
      }
      // existsSync follows links: a dangling symlink at `to` reports absent
      // yet would still make the rename fail, so drop the stale link itself.
      let stale = null;
      try {
        stale = fs.lstatSync(to);
      } catch {
        /* nothing at `to` */
      }
      if (stale) fs.unlinkSync(to);
      fs.renameSync(path.join(aside, name), to);
    }
    fs.rmdirSync(aside);
  } catch (err) {
    if (err instanceof PluginGitError) throw err;
    throw new PluginGitError(`git-subdir hoist failed: ${err && err.message ? err.message : String(err)}`, 'git_exit');
  }
}

/**
 * Fetch a remote plugin source into `finalDir`, atomically.
 *
 * Steps: safe-url check → require a declared sha → blobless clone into a temp
 * dir → (git-subdir) sparse-checkout the subdir → detached checkout of the sha
 * → (git-subdir) hoist `<subdir>/*` to the temp root → assert HEAD == declared
 * sha → atomic move temp → final. Any failure removes
 * the temp dir; the final dir is only ever populated by a completed, verified
 * fetch.
 *
 * If git is missing (`git_missing`) or the clone step fails (`clone_failed`)
 * and the source is a github.com repo, the codeload zip of the sha is fetched
 * instead (see `extractArchive` for the assertion it can offer). Any other
 * git failure — sha mismatch, timeout, unsafe input — fails as before.
 *
 * `runGit`, `move`, `remove` (and `downloadArchive`, `hoist`) are injected so
 * this orchestration is unit-tested without touching the network or filesystem.
 * In production they are the real `runGit` above, an atomic rename, a
 * recursive remove, and `downloadArchiveHttps`. `onArchiveFallback` is an
 * optional observer the dispatch uses to record which path produced the
 * package.
 *
 * @param {{kind:'url'|'git-subdir', url:string, sha?:string, path?:string}} source
 */
async function fetchRemoteSource(source, opts) {
  const { finalDir, tmpDir, runGit: run, move, remove, spawnImpl, env, timeoutMs, cloneUrl } = opts;
  const hoist = opts.hoist || hoistSubdir;

  // Always validate the *declared* url — even when cloneUrl overrides the
  // actual clone target (test hook), the marketplace url is what we vet.
  assertSafeGitUrl(source.url);
  if (!source.sha || typeof source.sha !== 'string') {
    // Unpinned installs are refused: reproducibility (and the sha assertion
    // below) is the whole point. Batch-1 found 82% of real entries pin a sha.
    throw new PluginGitError('remote plugin source must declare a sha', 'no_sha');
  }
  assertSafeSha(source.sha);
  if (source.kind === 'git-subdir' && !source.path) {
    throw new PluginGitError('git-subdir source must declare a path', 'no_subdir');
  }
  // Before any git work: the path goes into sparse-checkout argv and names
  // the directory the hoist moves, so it must be vetted here, not after clone.
  if (source.kind === 'git-subdir') assertSafeSubdirPath(source.path);

  const gitOpts = { spawnImpl, env, timeoutMs };
  try {
    try {
      await run(buildCloneArgs(cloneUrl ?? source.url, tmpDir), gitOpts);
      if (source.kind === 'git-subdir') {
        await run(buildSparseArgs(tmpDir, source.path), gitOpts);
      }
      await run(buildCheckoutArgs(tmpDir, source.sha), gitOpts);
      if (source.kind === 'git-subdir') {
        // Sparse checkout keeps repo-relative paths; the installer wants the
        // package at the root (same shape the archive fallback produces).
        await hoist(tmpDir, source.path);
      }

      const head = (await run(buildRevParseArgs(tmpDir), gitOpts)).trim();
      if (head !== source.sha) {
        // The guarantee Codex omits: advertised sha must equal served sha.
        throw new PluginGitError(
          `sha mismatch: declared ${source.sha}, got ${head}`,
          'sha_mismatch',
        );
      }
    } catch (gitErr) {
      if (!(gitErr instanceof PluginGitError) || !ARCHIVE_FALLBACK_CODES.has(gitErr.code)) throw gitErr;
      // The archive's only integrity check is the `<repo>-<sha>` root folder,
      // which GitHub names with the FULL sha. An abbreviated declared sha would
      // fail the git path's rev-parse assertion, so it must not be "rescued"
      // here either: fall through to the original git error.
      if (!FULL_SHA_RE.test(source.sha)) throw gitErr;
      // Always the *declared* url: cloneUrl is a test hook, never a fetch target.
      const archive = githubArchiveUrl(source.url, source.sha);
      if (!archive) throw gitErr;
      if (opts.onArchiveFallback) opts.onArchiveFallback(gitErr);
      const download = opts.downloadArchive || downloadArchiveHttps;
      // A failed clone may have left a partial tree behind — start clean.
      await remove(tmpDir).catch(() => {});
      fs.mkdirSync(tmpDir, { recursive: true });
      try {
        const bytes = await download(archive.url);
        extractArchive(bytes, source, tmpDir, archive.repo);
      } catch (archiveErr) {
        // Both failures matter for diagnostics: the archive one is what the
        // user sees, the git one is why we were here at all. Keep git's on
        // `cause` AND in the message — the renderer only forwards `message`.
        // The archive error's own code is kept: `sha_mismatch` (root folder is
        // not `<repo>-<sha>`) and `bad_args` (unsafe entry) are more precise
        // than a blanket `archive_failed` and callers key on them.
        const archiveMsg = archiveErr && archiveErr.message ? archiveErr.message : String(archiveErr);
        const code = archiveErr instanceof PluginGitError ? archiveErr.code : 'archive_failed';
        const combined = new PluginGitError(`${archiveMsg}; git: ${gitErr.message}`, code);
        combined.cause = gitErr;
        throw combined;
      }
    }

    await move(tmpDir, finalDir);
    return finalDir;
  } catch (err) {
    await remove(tmpDir).catch(() => {});
    throw err;
  }
}

module.exports = {
  PluginGitError,
  fetchRemoteSource,
  assertSafeGitUrl,
  assertSafeSha,
  assertSafeSubdirPath,
  buildCloneArgs,
  buildSparseArgs,
  buildCheckoutArgs,
  buildRevParseArgs,
  cleanGitEnv,
  runGit,
  GIT_HIJACK_VARS,
  githubArchiveUrl,
  isAllowedArchiveUrl,
  downloadArchiveHttps,
  extractArchive,
  hoistSubdir,
};

// ── IPC dispatch ─────────────────────────────────────────────────────────────

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** Sentinel: the command is not a plugin-git command. */
const PLUGIN_GIT_MISS = Symbol('plugin-git-miss');

/** Wall-clock ceiling for each git invocation. Generous but bounded. */
const GIT_TIMEOUT_MS = 120_000;

/**
 * The only directory the renderer may name as a fetch destination. A
 * compromised renderer must not be able to aim a clone at
 * ~/Library/LaunchAgents; scoping the destination here (in the privileged
 * process) means the renderer's path is a suggestion we verify, not an order.
 */
function defaultPackagesRoot() {
  return path.join(os.homedir(), '.abu', 'plugin-packages');
}

function assertUnderPackagesRoot(destDir, packagesRoot) {
  const resolvedRoot = path.resolve(packagesRoot);
  const resolved = path.resolve(destDir);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    throw new PluginGitError(
      `fetch destination must be inside the plugin-packages root: ${destDir}`,
      'dest_outside_root',
    );
  }
  return resolved;
}

/**
 * Handle `plugin_git_fetch`. Returns PLUGIN_GIT_MISS for any other command so
 * the tauriHost dispatch chain falls through.
 *
 * `payload.__testOverrides` exists for the e2e test only: `cloneUrl` swaps the
 * (https-validated) marketplace url for a local repo path at clone time, and
 * `packagesRoot` rescopes the destination guard to a scratch dir. Production
 * callers never pass it — tauriHost forwards `{ args }` alone.
 */
function pluginGitDispatch(cmd, payload, hostOptions = {}) {
  if (cmd !== 'plugin_git_fetch') return PLUGIN_GIT_MISS;

  const { source, destDir } = (payload && payload.args) || {};
  const overrides = (payload && payload.__testOverrides) || {};

  return (async () => {
    if (!source || typeof source !== 'object') {
      throw new PluginGitError('plugin_git_fetch needs a source', 'bad_args');
    }
    // A git-subdir path is vetted before anything else (staging dir, git).
    if (source.kind === 'git-subdir') {
      if (!source.path) throw new PluginGitError('git-subdir source must declare a path', 'no_subdir');
      assertSafeSubdirPath(source.path);
    }
    if (typeof destDir !== 'string' || destDir.length === 0) {
      throw new PluginGitError('plugin_git_fetch needs a destDir', 'bad_args');
    }
    // Validate the declared (marketplace) url even when the test override
    // substitutes a local path for the actual clone.
    assertSafeGitUrl(source.url);
    if (!source.sha) throw new PluginGitError('remote plugin source must declare a sha', 'no_sha');

    // The main process supplies its profile root; renderer args cannot select
    // it. This also keeps isolated Electron runs out of the system home.
    const packagesRoot = hostOptions.packagesRoot || overrides.packagesRoot || defaultPackagesRoot();
    const finalDir = assertUnderPackagesRoot(destDir, packagesRoot);

    const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-plugin-fetch-'));
    const cloneTarget = path.join(stagingDir, 'repo');

    let via = 'git';
    try {
      await fetchRemoteSource(source, {
        finalDir,
        tmpDir: cloneTarget,
        cloneUrl: overrides.cloneUrl, // undefined in production → clone from source.url
        runGit: (args, opts) => runGit(args, { ...opts, timeoutMs: GIT_TIMEOUT_MS }),
        move: async (from, to) => {
          fs.mkdirSync(path.dirname(to), { recursive: true });
          fs.rmSync(to, { recursive: true, force: true });
          fs.renameSync(from, to);
        },
        remove: async (p) => fs.rmSync(p, { recursive: true, force: true }),
        onArchiveFallback: (gitErr) => {
          via = 'archive';
          console.warn(`[plugin-git] git unavailable (${gitErr.code}: ${gitErr.message}); falling back to GitHub archive for ${source.url}`);
        },
      });
      // The .git directory is fetch machinery, not package content — shipping
      // it would bloat the install and leak remote metadata into the package.
      // (No-op on the archive path: a codeload zip carries no .git.)
      fs.rmSync(path.join(finalDir, '.git'), { recursive: true, force: true });
      return { destDir: finalDir, sha: source.sha, via };
    } finally {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }
  })();
}

module.exports.pluginGitDispatch = pluginGitDispatch;
module.exports.PLUGIN_GIT_MISS = PLUGIN_GIT_MISS;
