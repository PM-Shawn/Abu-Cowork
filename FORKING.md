# Fork & Distribution Guide

[中文](FORKING.zh-CN.md) | **English**

Abu is Apache-2.0 open-source software. You may modify and redistribute this
repository, but a modified desktop package must not impersonate the official
Abu distribution or consume its production update channel.

## Develop locally

```bash
npm ci
npm run setup:electron-dev
npm run electron:dev
```

Development data is isolated from the installed application. A local package
can be produced with `npm run dist:electron`; validate distributable packages
on the operating system and CPU architecture that will run them.

## Safe defaults

The base `electron-builder.yml` sets:

- `abuRelease.officialBuild: false` — the packaged updater stays disabled;
- `abuRelease.tauriMigration: false` — installed official Abu data is not read
  or migrated;
- `publish: null` — no official or inferred update provider is embedded.

Only the official `PM-Shawn/Abu-Cowork` release workflow may override all three
controls together. Do not copy the official marker or OSS URL into a fork.

## Before redistributing a modified build

Choose identifiers that cannot collide with official Abu:

1. Change `appId` and `productName` in `electron-builder.yml`.
2. Change the `abu://` protocol name/scheme and every matching handler.
3. Use a distinct user-data directory and updater cache name.
4. Replace icons, copyright, support links, and package names where appropriate.
5. Configure an update feed you control, or leave updates disabled.

Keeping `com.abu.app`, the `Abu` product name, or the official user-data path can
cause two independently built applications to share OS registration, shortcuts,
uninstall identity, or local data.

## Signing and release workflows

Official signing and publishing secrets are not part of this repository:

- Apple Developer ID certificate and App Store Connect notarization key;
- Tauri transition signing key used only for the v0.34 framework bridge;
- Aliyun OSS credentials for the official update feeds;
- Windows Authenticode credentials (the current official Windows package is
  unsigned).

Tag-triggered production publishing is guarded to the official repository.
Fork maintainers should create their own workflow, identities, signing setup,
artifact store, update feed, and rollback procedure. A manual Windows candidate
can remain unsigned; disclose the resulting SmartScreen warning to users.

## Open-core boundary

This public repository contains personal-mode code and public enterprise
interfaces/stubs. Do not copy private enterprise implementations, credentials,
customer configuration, or `.env.local` values into a fork or pull request.
See [`docs/ENTERPRISE-BUILD.md`](docs/ENTERPRISE-BUILD.md) for the boundary.
