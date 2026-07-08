# Abu Website Deployment Guide

**English** | [中文](README.zh-CN.md)

## Directory Structure

```
website/
├── index.html          # Main page
├── index.zh-CN.html    # Main page (Chinese)
├── docs.html           # Documentation page
├── docs.zh-CN.html     # Documentation page (Chinese)
├── one-screen.html     # Single-screen landing page
├── one-screen.zh-CN.html # Single-screen landing page (Chinese)
├── style.css           # Main stylesheet
├── docs.css            # Documentation page stylesheet
├── docs/               # Markdown documentation
│   ├── User-Guide.md
│   ├── User-Guide.zh-CN.md
│   ├── Installation-Guide.md
│   ├── Installation-Guide.zh-CN.md
│   └── browser-bridge-vs-playwright.md
└── assets/
    ├── abu-avatar.png  # Mascot image
    ├── wechat-qr.png   # WeChat QR code
    └── screenshot-*.png # Product screenshots
```

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
