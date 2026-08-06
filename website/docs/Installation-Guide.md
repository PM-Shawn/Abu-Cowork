# Abu Installation Guide

**English** | [中文](Installation-Guide.zh-CN.md)

## Download

Head to [GitHub Releases](https://github.com/PM-Shawn/Abu-Cowork/releases) to download the installer for your platform:

| Platform | File |
|----------|------|
| macOS (Apple Silicon) | `Abu-x.x.x-mac-arm64.dmg` |
| macOS (Intel) | `Abu-x.x.x-mac-x64.dmg` |
| Windows x64 | `Abu-x.x.x-windows-x64-setup.exe` |

Official desktop packages currently support macOS and Windows. There is no Linux installer yet. Do not treat the `Source code` archives on the Release page as desktop installers.

If you are unsure which Mac package to choose, select Apple menu  → **About This Mac**. Choose `arm64` for an Apple M-series chip and `x64` for an Intel processor.

---

## macOS Installation

### 1. Install the App

Double-click the `.dmg` file and drag Abu into the `Applications` folder.

### 2. First Launch

Official macOS packages are Developer ID signed, notarized, and stapled. Open Abu from the Applications folder normally. macOS may ask for permissions only when you use capabilities such as files, microphone, accessibility, or app automation.

If Gatekeeper reports that an official package is damaged or cannot be verified, do not bypass the warning with `xattr` or by disabling Gatekeeper. Delete that copy and download the matching architecture again from the official GitHub Release. If the problem remains, report the release version, Mac model, and macOS version.

Source/fork builds are not covered by Abu's official signature. Their maintainer must provide separate signing and installation instructions.

### 3. Update

Check for updates under **Abu → Settings → Version**. Treat the official Release and the in-app update prompt as authoritative. Do not install repackaged or unofficial “enhanced” builds.

---

## Windows Installation

### 1. Install the App

Double-click the `.exe` installer and follow the prompts.

### 2. Handle SmartScreen Warning

Since Abu is not yet code-signed, Windows SmartScreen may show:

> Windows protected your PC — prevented an unrecognized app from starting.

**Solution:**

1. Click **"More info"** in the popup
2. Click **"Run anyway"**

The app will launch normally.

### Alternative: Unblock via Properties

If the installer won't run after downloading:

1. Right-click the `.exe` file → select **"Properties"**
2. At the bottom, find the **"Security"** section and check **"Unblock"**
3. Click **"OK"**, then double-click to install

### 3. Update

Check for updates under **Abu → Settings → Version**. Stop active tasks before installing a new version. The installer updates the application and does not intentionally remove your project files or conversation history.

---

## FAQ

### Q: Is this safe?

Abu is open-source software and its source can be reviewed on GitHub. Official macOS packages are signed and notarized. The Windows warning appears because the Windows installer does not yet have an Authenticode certificate; verify that you downloaded it from the official Release before choosing **Run anyway**.

### Q: Do I need to do this after every update?

- **macOS**: No. Official updates remain signed and notarized.
- **Windows**: SmartScreen behavior depends on Windows reputation and may appear again for a new installer.

### Q: Will this be fixed in the future?

macOS signing and notarization are already enabled. Windows Authenticode signing will be added after an appropriate certificate is available.

### Q: What if I downloaded the wrong architecture?

Delete the incorrect installer and download the matching package. Apple Silicon Macs use `mac-arm64.dmg`; Intel Macs use `mac-x64.dmg`. Do not use translation as a substitute for the correct build.

### Q: Why is no model available after installation?

Installation deploys the client only. For first use, select your avatar in the lower-left corner, open **Settings → Models**, and add a model service, API key, and model. If the connection fails, run **Settings → Diagnostics**.
