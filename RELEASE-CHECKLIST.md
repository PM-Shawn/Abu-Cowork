# Release Checklist

One page — follow top to bottom when cutting a release. Rationale and red-lines
live in [`CLAUDE.md`](./CLAUDE.md) (Release Process) and the release-notes writing
convention in [`RELEASING.md`](./RELEASING.md). This page is the actionable source.

## 0. Preconditions

- On `dev`, up to date (`git checkout dev && git pull origin dev`).
- `dev` CI is green (build + lint + test).

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
```

- [ ] All four pass.
- [ ] (Recommended) `npm run tauri:dev` — smoke new UI / behavior changes on a real desktop build.

## 3. Release

```bash
git push origin dev
git checkout main && git merge dev     # merge ONLY — never cherry-pick
git tag vX.Y.Z
git push origin main
git push origin vX.Y.Z                 # push the ONE tag — do NOT use --tags
git checkout dev
```

## 4. CI does the rest (automatic, ~40 min)

`Release` workflow: `preflight` (release:check) → `build` (mac arm64 + mac x64 + Windows) → sign + notarize (macOS) → **GitHub Release** (English, from `CHANGELOG.md`) → `latest.json` (`notes` + per-locale `notes_i18n`) → upload to OSS.

- [ ] Confirm the `Release` run started (`gh run list --workflow=release.yml`).
- [ ] (Optional) once the release exists, give it a subtitle: `gh release edit vX.Y.Z --title "vX.Y.Z — <subtitle>"` (CI titles it with the bare tag).

## 5. Post-release

- [ ] Real-machine smoke the signed build (especially Windows / a machine without Node).
- [ ] Update / add a memory note if the release exposed follow-ups.

## Red lines (don't)

- ❌ **Never cherry-pick `dev` → `main`** — merge only. (Twin commits → divergence → fake-conflict snowball.)
- ❌ **Never `git push origin main --tags`** — pushing >3 tags at once makes GitHub skip the tag push events, so the `Release` workflow never fires. Push the single tag.
- ❌ **Never mix languages** in a changelog file — `CHANGELOG.md` is English, `CHANGELOG.zh-CN.md` is Chinese. (`release:check` will fail the release if you do.)
- ❌ **Never commit on `main`** or `git push --force` to `main`/`dev`.
