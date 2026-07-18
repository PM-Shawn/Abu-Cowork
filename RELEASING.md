# Release Notes Convention

Release notes writing convention for Abu. Use alongside the Release Process section in `CLAUDE.md`.

> **Core principle — two files, dual-maintained by language**: Each release gets its entry written in **both** changelogs, never mixed in one file:
> - **`CHANGELOG.md` (English, canonical)** → the GitHub Release + `latest.json.notes` (English default for the Tauri updater and international users).
> - **`CHANGELOG.zh-CN.md` (Chinese)** → `latest.json.notes_i18n["zh-CN"]`.
>
> CI extracts this version's section from each file into `latest.json.notes_i18n`; the **client (`checker.ts`) picks notes by the user's UI locale** and the website picks by page language. Same version and structure in both files, but one language each. Patches use the minimal template; Minor+ uses the full template. Always explain "why" and include specific numbers.

---

## Three-Tier Templates

### Patch (vX.Y.Z++) — Single fix / minor improvement

**Criteria**: 1–2 commits, single topic, no new features or breaking changes.

```markdown
## vX.Y.Z — One-line topic

**Root cause**: [One sentence explaining the nature of the bug / motivation for the improvement]

**Fix**:
- [User-visible impact 1]
- [User-visible impact 2]
- [Key technical detail when necessary, e.g. "9 spawn calls given CREATE_NO_WINDOW"]

Full Changelog: https://github.com/PM-Shawn/Abu-Cowork/compare/vX.Y.Z-1...vX.Y.Z
```

**Reference example**: [v0.13.6](https://github.com/PM-Shawn/Abu-Cowork/releases/tag/v0.13.6) (Windows PowerShell popup fix).

**Anti-example**: v0.13.5 only had "See the assets below" — users can't tell what changed; don't do this.

---

### Minor (vX.Y.0) — New features / multiple fix rollup

**Criteria**: Contains at least one new feature, or aggregates ≥3 user-visible fixes.

```markdown
## ✨ Features

- **feat(module)**: One-line description — Why it matters
  - Sub-point: specific behavior / user scenario
  - Sub-point: key numbers where relevant

## 🐛 Fixes

- **fix(module)**: Description (with root cause or scenario as needed)
- **fix(module)**: Description

## 🪟 Platform-Specific (optional — only when Windows / macOS-specific changes exist)

- **Windows**: ...
- **macOS**: ...

## English Summary

- 3–5 lines in English, for international users and AI crawlers
- Highlight key features + key fixes; no need to translate line by line
- Optionally note migration / breaking changes at the end

**Full Changelog**: https://github.com/PM-Shawn/Abu-Cowork/compare/vX.Y-1.0...vX.Y.0
```

**Reference examples**: [v0.13.9](https://github.com/PM-Shawn/Abu-Cowork/releases/tag/v0.13.9) (PPTX preview + website refresh), [v0.13.12](https://github.com/PM-Shawn/Abu-Cowork/releases/tag/v0.13.12) (diagnostics panel + confirm-dialog fix).

**When to add English Summary**: Add it when the release will be posted to a public channel, website download page, or international distribution. Skip it for purely internal fixes.

---

### Major (vX.0.0) — Architectural changes / breaking updates

**Criteria**: Contains breaking changes, data migrations, or dependency upgrades that require user action.

Extend the Minor template with:

```markdown
## ⚠️ Breaking Changes

- [Change]: [Scope of impact] → [What users need to do]

## 🔄 Migration Notes

1. [Step 1]
2. [Step 2]
3. **Rollback plan**: [How to revert if the upgrade goes wrong]

## Data Migration (if applicable)

- Automatic migration from previous version: Yes / No
- Affected stores: abu-chat (vN→vN+1), etc.
- Fallback behavior if migration fails
```

---

## Writing Guidelines

### 1. Title Format

| Tier | Format | Example |
|---|---|---|
| Patch (single topic) | `vX.Y.Z — One-line topic` | `v0.13.6 — Fix Windows PowerShell popup` |
| Patch (miscellaneous) | `vX.Y.Z` | `v0.13.10` |
| Minor | `vX.Y.0 — Topic` or `vX.Y.0` | `v0.13.9 — Preview improvements + website refresh` |
| Major | `vX.0.0 — Topic` | `v1.0.0 — Public release` |

A subtitle makes the release list scannable. **Strongly recommended even for patches** (except pure chore/CI fixes).

### 2. Two Files, One Language Each

- **`CHANGELOG.md` — English only** (canonical). Drives the GitHub Release and `latest.json.notes`. Public / international / AI-crawler facing.
- **`CHANGELOG.zh-CN.md` — Chinese only**. Drives `latest.json.notes_i18n["zh-CN"]`, shown in the in-app update dialog for zh-CN users and on the Chinese website.
- **Same release, two files, never mixed.** Write the entry once in each language — don't append English tails to Chinese bullets or vice-versa. The `## vX.Y.Z · DATE` heading and section structure must match across both so CI extracts them consistently.
- **CI routing** (`.github/workflows/release.yml`): the "Create GitHub Release" step reads `CHANGELOG.md`; the publish step's `latest.json` generator extracts this version's section from **both** files into `notes` (English) + `notes_i18n` (`en-US` + `zh-CN`). The client (`src/core/updates/checker.ts`) refetches `latest.json` and selects `notes_i18n[getLocale()]`, falling back to the English `notes`.
- **History before v0.31.0** predates this split and lives only in `CHANGELOG.md` (bilingual); no need to backfill the Chinese file.

### 3. Explain "why", not just "what"

Every bullet should convey real value, not just implementation details:

✅ `MCP status fix: status no longer sticks after MCP service errors or connection tests complete` — clear user scenario
❌ `Refactor mcpStore` — users don't care
❌ `Optimize performance` — doesn't say what was optimized

### 4. Numbers are evidence

Consistent with the house voice style — use numbers when you have them:

✅ "TTL extended from 5s to 30s, reducing PowerShell invocation frequency"
✅ "9 subprocess spawn calls given `CREATE_NO_WINDOW`"
✅ "Skill count updated from 25+ to 28"

❌ "Significant performance improvement"
❌ "Noticeably better experience"

### 5. Emoji Usage

- **Patch titles**: No emoji (looks like clickbait).
- **Minor+ sections**: Emoji are fine — ✨ / 🐛 / 🪟 / 🍎 / ⚠️ / 🔄 — to make sections instantly identifiable.
- **Inside bullets**: Avoid emoji.

### 6. Links and Changelog

- Always append a `Full Changelog: ...compare/...` link at the end (auto-generated by `gh release` is fine to keep).
- You may reference a specific commit short SHA, but don't paste a raw list of PR numbers.

---

## Common Anti-Patterns

1. **Empty release**: "See the assets below" / "Bug fixes and improvements" — meaningless; users can't decide whether to upgrade.
2. **Machine-translated full body**: Line-by-line bilingual looks bloated and the English quality is usually worse than a concise English Summary.
3. **Raw commit log dump**: Pasting `git log --oneline` output directly — no filtering or organization; users can't parse it.
4. **Excessive technical detail**: Users don't understand "Refactor chatStore.normalizer to nullable schema" — write "Fix occasional message loss when switching models" instead.
5. **Hiding breaking changes**: A major release without Migration Notes is a landmine.

---

## Checklist (run through before creating a release)

- [ ] **Both changelogs written for this version**: `CHANGELOG.md` (English) and `CHANGELOG.zh-CN.md` (Chinese)?
- [ ] **`npm run release:check` passes** (version consistency + both changelog sections in the right language)? CI also gates this in the `preflight` job, but run it locally first.
- [ ] Tag pushed **on its own** (`git push origin vX.Y.Z`), not with `--tags`?
- [ ] Does the title have a descriptive subtitle?
- [ ] Does every bullet clearly state the user-facing impact?
- [ ] Is there at least one specific number?
- [ ] Patch: under 200 words? Minor+: divided into sections?
- [ ] Is there a Full Changelog link?
- [ ] Major: are Breaking Changes and Migration Notes included?
- [ ] Have vague phrases like "significant improvement" been avoided?

---

## gh CLI Quick Reference

### Recommended workflow (avoid duplicate releases)

⚠️ **This repo's CI automatically creates a release after a tag push** (default title `Abu vX.Y.Z`, body is the placeholder "See the assets below…" — exactly the anti-example in this doc) and uploads build artifacts as assets. So **do not use `gh release create`** — it creates a second release while the auto-generated one remains, with its title/body uncorrected.

Correct order:

```bash
# 1. Write release notes to a file (avoids shell escaping issues)
vim /tmp/release-notes.md

# 2. Push main, then the tag ON ITS OWN (triggers CI: preflight → build → release)
#    Do NOT use `git push origin main --tags`: pushing >3 tags at once makes
#    GitHub skip the tag push events, so the Release workflow never fires.
git push origin main
git push origin vX.Y.Z

# 3. Wait for CI to create the release (visible in release list is enough — no need to wait for assets)
gh release list --limit 3

# 4. Overwrite the auto-release title and body (targets that release by tag)
gh release edit v0.23.1 --title "v0.23.1 — Topic" -F /tmp/release-notes.md

# 5. (Optional) Wait for assets to finish uploading, then announce
```

### Other common commands

```bash
# View how the previous release was written (copy as template)
gh release view v0.23.0 --json body -q .body

# List all assets for a release
gh release view v0.23.1 --json assets -q '.assets[].name'

# Only use create when starting from scratch (no CI auto-release scenario)
gh release create vX.Y.Z --title "..." -F /tmp/notes.md
```

### Known gotchas

- `gh release create --draft` + `gh release edit --draft=false`: A draft is in untagged state; publishing it **creates a new** release that claims the tag, while the CI-generated one still exists. The result is two releases for the same tag. If you need a draft workflow, first delete the CI-generated release via the API (`gh api -X DELETE /repos/PM-Shawn/Abu-Cowork/releases/<id>`), then publish your draft. In most cases this isn't necessary — editing the auto-generated release directly is faster.
