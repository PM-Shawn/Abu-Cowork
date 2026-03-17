# ABU 官网部署指南

## 目录结构

```
website/
├── index.html          # 主页面
├── docs.html           # 文档页面
├── style.css           # 主样式
├── docs.css            # 文档页样式
├── docs/               # Markdown 文档
│   ├── User-Guide.md
│   ├── Installation-Guide.md
│   └── browser-bridge-vs-playwright.md
└── assets/
    ├── abu-avatar.png  # 吉祥物图片
    ├── wechat-qr.png   # 微信二维码
    └── screenshot-*.png # 产品截图
```

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
