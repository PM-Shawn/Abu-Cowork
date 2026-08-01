# Electron transition release

This runbook applies while installed Tauri clients are being moved to Electron.
It is intentionally stricter than an ordinary Electron-only release.

## User switch

The production root `latest.json` remains the discovery endpoint for installed
Tauri clients. A transition release must contain exactly these platform entries:

- `darwin-aarch64`: Tauri-signed Electron arm64 `Abu.app.tar.gz`
- `darwin-x86_64`: Tauri-signed Electron x64 `Abu.app.tar.gz`
- `windows-x86_64`: Tauri-signed Electron x64 current-user NSIS installer

The Tauri signature is an updater integrity signature and is required on all
three platforms. It is separate from Apple code signing and Windows
Authenticode. macOS artifacts must still be Developer ID signed and notarized.
The Windows installer may be Authenticode-unsigned for this release, which
means first/manual installs can show SmartScreen.

After the transition, Electron clients no longer read the root `latest.json`.
They use architecture-isolated feeds:

- `/electron/mac-arm64/latest-mac.yml`
- `/electron/mac-x64/latest-mac.yml`
- `/electron/win-x64/latest.yml`

The release workflow uploads and byte-verifies every referenced artifact,
publishes the three Electron feed pointers, and changes the root `latest.json`
last. If any build, signature, upload, or verification fails, installed Tauri
clients remain on the previous version.

## Data migration safety

Tauri remains the read-only source of truth during the first Electron launch.
Electron uses the separate `com.abu.app.electron` data root.

- `conversations/`, `sessions/`, and `backups/` are copied through staging and
  activated only after validation. If an Electron test/RC profile already
  exists, it is retained in the recovery backup before the installed Tauri
  profile supplies the authoritative transition values.
- macOS `secrets.bin` values are decrypted with the existing machine-derived
  key and re-encrypted with Electron safeStorage. The original file is never
  copied, changed, or deleted.
- Windows secrets are read from Credential Manager through an allowlisted
  native reader and re-encrypted into Electron storage.
- macOS WebKit and Windows WebView2 localStorage are read without modifying the
  live databases. Only Abu-owned keys are eligible.
- Migration sentinels are valid only when their JSON record is complete. They
  are written through a temporary file plus atomic rename.
- A preparation, secret-store, directory-copy, renderer-write, or
  acknowledgement failure leaves the sentinel absent and stops the first
  Electron launch before the UI is shown. Restarting retries the migration.

The old source data is retained throughout the transition.

Source/fork builds must keep `abuRelease.officialBuild=false`,
`abuRelease.tauriMigration=false`, and `publish: null`. Only official release CI
may arm migration and embed an architecture-specific production updater feed.

## Rollback

- Windows: the old Tauri installation directory is preserved for one release.
  The Electron installer writes its own current-user Programs directory and
  shortcut. Uninstalling Electron must not remove the Tauri rollback install.
- macOS: the updater replaces `Abu.app`, but the Tauri data directory remains
  untouched. Rollback is reinstalling the retained v0.33.0 DMG; it reopens the
  original Tauri data.

Do not remove v0.33.0 release artifacts or old Tauri data during the transition
window.

## Release gates

Before changing the root `latest.json`:

1. `npm run release:check`, build, lint, full test, parity, bootstrap, migration,
   security, and release-workflow tests pass.
2. macOS arm64 and x64 packages are built on matching native runners, signed,
   notarized, stapled, architecture-checked, and packaged-smoked.
3. Windows x64 is built on `windows-latest`; the installed smoke covers launch,
   sidecar, PTY, bundled Node/Python, IPC, migration, shortcut ownership, and
   rollback preservation.
4. Start from an installed v0.33.0 on each platform, trigger the in-app update,
   and verify conversations, settings, credentials, and the old source data.
5. Verify one Electron-to-Electron update on each platform using the staged
   architecture-specific feed.
6. Confirm the final RC commit is the exact commit being promoted through
   `dev` to `main`, and that a fork-like package cannot consume the official
   updater or installed Abu data.

Only the final root-pointer step exposes the transition to existing users.
