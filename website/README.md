# Abu Website Deployment Guide

**English** | [中文](README.zh-CN.md)

## Directory Structure

| Path under `website/` | Contents |
|---|---|
| `index.html`, `index.zh-CN.html` | Home page, English and Chinese |
| `enterprise.html`, `enterprise.zh-CN.html` | Enterprise page, English and Chinese |
| `docs.html`, `docs.zh-CN.html` | Documentation page, English and Chinese |
| `one-screen.html`, `one-screen.zh-CN.html` | Single-screen landing page |
| `site.css`, `site.js` | Styles and script shared by every page: colors for the light and dark appearance, navigation, buttons, closing block |
| `home.css`, `home.js` | Home page only: hero, product preview, release record behind the version and the download buttons |
| `enterprise.css` | Enterprise page only |
| `docs.css`, `docs.js` | Documentation page only: reads and renders the Markdown guides and the release notes of the current version |
| `docs/` | Markdown guides shown on the documentation page; `User-Guide*.md` and `Installation-Guide*.md` mirror the repository's `docs/` |
| `assets/shots/` | Screenshots of the desktop client used by the pages (WebP; `-1440` files are the half-size versions for small screens; `hero-window-*` is the home hero, `step-*` are 3:2 regions cut from whole-window screenshots) |
| `assets/fonts/` | Self-hosted serif fonts: Noto Serif SC 500 and Instrument Serif, with their licenses |
| `assets/vendor/` | The Markdown renderer (`marked`) used by the documentation page |
| `assets/abu-avatar-120.png`, `assets/wechat-qr.png` | Mascot icon and the author's WeChat QR code |
| `assets/screenshot-*.png`, `assets/readme-cover.*.jpg` | Pictures used by the repository README files |

`npm run test:website` checks the pages; it runs before every deployment.

## Deploy to GitHub Pages

### Option 1: Deploy from the /website directory on the main branch

1. Push the code to GitHub.
2. Go to the repository **Settings → Pages**.
3. Set **Source** to the `main` branch and the directory to `/website`.
4. Save and wait for the deployment to complete.

### Option 2: Create a gh-pages branch

1. Create the gh-pages branch:
   ```bash
   git checkout -b gh-pages
   cd website
   git add -A
   git commit -m "Deploy website"
   git push origin gh-pages
   ```

2. Go to the repository **Settings → Pages**.
3. Set **Source** to the `gh-pages` branch.
4. Save and wait for the deployment to complete.

## URLs

- Repository: https://github.com/PM-Shawn/Abu-Cowork
- Website: Once deployed, accessible at `https://pm-shawn.github.io/Abu-Cowork/`

## Local Preview

Open `index.html` directly in your browser for a local preview:

```bash
open website/index.html
```
