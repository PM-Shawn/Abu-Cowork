# ABU 官网部署指南

[English](README.md) | **中文**

## 目录结构

| `website/` 下的路径 | 内容 |
|---|---|
| `index.html`、`index.zh-CN.html` | 首页，英文与中文 |
| `enterprise.html`、`enterprise.zh-CN.html` | 企业版页面，英文与中文 |
| `docs.html`、`docs.zh-CN.html` | 文档页，英文与中文 |
| `one-screen.html`、`one-screen.zh-CN.html` | 单屏落地页 |
| `site.css`、`site.js` | 所有页面共用的样式和脚本：浅色与深色外观的颜色、导航、按钮、结尾区块 |
| `home.css`、`home.js` | 只用于首页：首屏、产品预览、版本号和下载按钮使用的发布信息 |
| `enterprise.css` | 只用于企业版页面 |
| `docs.css`、`docs.js` | 只用于文档页：读取并显示 Markdown 文档和当前版本的更新日志 |
| `docs/` | 文档页显示的 Markdown 文档；`User-Guide*.md` 与 `Installation-Guide*.md` 和仓库的 `docs/` 保持一致 |
| `assets/shots/` | 页面使用的客户端截图（WebP；文件名带 `-1440` 的是给小屏幕用的一半尺寸；`hero-window-*` 是首页首屏的窗口，`step-*` 是从整窗截图里取出的 3:2 区域） |
| `assets/fonts/` | 放在自己服务器上的衬线字体：Noto Serif SC 500 与 Instrument Serif，附带各自的许可证 |
| `assets/vendor/` | 文档页使用的 Markdown 渲染库（`marked`） |
| `assets/abu-avatar-120.png`、`assets/wechat-qr.png` | 阿布头像图标与作者的微信二维码 |
| `assets/screenshot-*.png`、`assets/readme-cover.*.jpg` | 仓库 README 使用的图片 |

`npm run test:website` 检查这些页面，每次部署之前都会运行。

## 部署到 GitHub Pages

### 方式一：从 main 分支 /website 目录部署

1. 将代码推送到 GitHub
2. 进入仓库 Settings → Pages
3. Source 选择 `main` 分支，目录选择 `/website`
4. 保存后等待部署完成

### 方式二：创建 gh-pages 分支

1. 创建 gh-pages 分支：
   ```bash
   git checkout -b gh-pages
   cd website
   git add -A
   git commit -m "Deploy website"
   git push origin gh-pages
   ```

2. 进入仓库 Settings → Pages
3. Source 选择 `gh-pages` 分支
4. 保存后等待部署完成

## 访问地址

- 仓库：https://github.com/PM-Shawn/Abu-Cowork
- 官网：部署完成后通过 `https://pm-shawn.github.io/Abu-Cowork/` 访问

## 本地预览

直接用浏览器打开 `index.html` 即可本地预览：

```bash
open website/index.html
```
