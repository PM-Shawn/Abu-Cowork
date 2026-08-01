# Release Checklist

One page — follow top to bottom when cutting a release. Rationale and red-lines
live in [`CLAUDE.md`](./CLAUDE.md) (Release Process) and the release-notes writing
convention in [`RELEASING.md`](./RELEASING.md). This page is the actionable source.

## 0. Preconditions

- All release work is merged into `dev`; the release worktree is clean.
- `dev` is up to date and CI is green. Resolve feature/main conflicts before
  promotion; do not repair them directly on `main`.
- The release commit contains no `.env.local`, signing material, private module,
  customer data, or internal-only URL.

## 1. Prepare (on `dev`)

- [ ] Bump the version in **all four** files to `X.Y.Z`:
  - `package.json`
  - `src-tauri/tauri.conf.json`
  - `src-tauri/Cargo.toml`
  - `src-tauri/Cargo.lock` (the `name = "abu"` entry)
- [ ] Write this version's entry in **both** changelogs (same version + structure, one language each — never mixed):
  - `CHANGELOG.md` — **English only**
  - `CHANGELOG.zh-CN.md` — **Chinese only**
- [ ] Commit to `dev`.

## 2. Verify — fail here, not after tagging

```bash
npm run release:check      # version match across 4 files + both changelog sections in the right language
npm run build              # gen:models:check + tsc + vite build
npm run lint
npm test
npm run test:electron:release-stage
npm run test:electron:release-workflow
npm run parity:check
bash scripts/enterprise-leak-guard.sh
```

- [ ] Every command above passes.
- [ ] `npm run electron:dev` — smoke new UI / behavior changes in the Electron shell.
- [ ] A source/fork package has `officialBuild=false`, `tauriMigration=false`,
      and no production `app-update.yml`.
- [ ] For the Tauri → Electron transition, complete every gate in
      [`ELECTRON-TRANSITION-RELEASE.md`](./ELECTRON-TRANSITION-RELEASE.md).
- [ ] Cut one final RC from the exact release commit and confirm macOS arm64,
      macOS x64, and Windows x64 native CI before creating the stable tag.

## 3. Release

```bash
git push origin dev
git checkout main && git pull --ff-only origin main
git merge dev                          # merge ONLY — never cherry-pick
git tag vX.Y.Z
git push origin main
git push origin vX.Y.Z                 # push the ONE tag — do NOT use --tags
git checkout dev
```

## 4. CI does the rest (automatic, ~40 min)

`Release` workflow: `preflight` → native Electron builds (mac arm64 + mac x64 +
Windows x64) → macOS sign/notarize + Windows installed smoke → stage and
byte-verify all artifacts → publish the three Electron self-update feeds →
switch the Tauri `latest.json` last.

- [ ] Confirm the `Release` run started (`gh run list --workflow=release.yml` or GitHub Actions UI).
- [ ] Do not manually create a second Release. CI prepares a draft, uploads and
      verifies production bytes, switches the legacy Tauri pointer last, then
      publishes that same Release.

## 5. Post-release

- [ ] Confirm the GitHub Release contains the two DMGs and Windows setup EXE,
      with matching update metadata and blockmaps.
- [ ] Real-machine smoke the published build (especially Windows / a machine without Node).
- [ ] Keep v0.33.0 artifacts and the pre-release root `latest.json` available
      throughout the v0.34 transition window.
- [ ] Monitor migration, launch, updater, and browser-bridge reports for 24 hours.
- [ ] Update / add a memory note if the release exposed follow-ups.

## Red lines (don't)

- ❌ **Never cherry-pick `dev` → `main`** — merge only. (Twin commits → divergence → fake-conflict snowball.)
- ❌ **Never `git push origin main --tags`** — pushing >3 tags at once makes GitHub skip the tag push events, so the `Release` workflow never fires. Push the single tag.
- ❌ **Never mix languages** in a changelog file — `CHANGELOG.md` is English, `CHANGELOG.zh-CN.md` is Chinese. (`release:check` will fail the release if you do.)
- ❌ **Never commit on `main`** or `git push --force` to `main`/`dev`.
