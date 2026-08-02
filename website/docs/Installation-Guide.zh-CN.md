# Abu 安装指南

[English](Installation-Guide.md) | **中文**

## 下载

前往 [GitHub Releases](https://github.com/PM-Shawn/Abu-Cowork/releases) 下载对应平台的安装包：

| 平台 | 文件格式 |
|------|----------|
| macOS (Apple Silicon) | `Abu-x.x.x-mac-arm64.dmg` |
| macOS (Intel) | `Abu-x.x.x-mac-x64.dmg` |
| Windows x64 | `Abu-x.x.x-windows-x64-setup.exe` |

---

## macOS 安装

### 1. 安装应用

双击 `.dmg` 文件，将 Abu 拖入 `Applications` 文件夹。

### 2. 首次启动

官方 macOS 包已经完成 Developer ID 签名、公证和 staple。把阿布放入「应用程序」后可正常打开；只有在使用文件、麦克风、辅助功能或应用自动化等能力时，macOS 才会按需请求权限。

如果官方包仍提示“已损坏”或“无法验证开发者”，请不要使用 `xattr` 绕过，也不要关闭 Gatekeeper。删除当前副本，从官方 GitHub Release 重新下载与机器架构匹配的包；仍有问题时，请反馈版本号、Mac 型号和 macOS 版本。

源码或 fork 自行构建的包不在阿布官方签名范围内，应由其维护者提供独立的签名和安装说明。

---

## Windows 安装

### 1. 安装应用

双击 `.exe` 安装包，按提示完成安装。

### 2. 处理 SmartScreen 拦截

由于 Abu 目前未进行代码签名，首次运行时 Windows SmartScreen 可能弹出以下提示：

> Windows 已保护你的电脑 — 阻止了无法识别的应用启动。

**解决方法：**

1. 点击弹窗中的 **「更多信息」**（More info）
2. 点击 **「仍要运行」**（Run anyway）

应用即可正常启动。

### 备选方法：右键属性解除锁定

如果安装包下载后无法运行：

1. 右键点击 `.exe` 文件 → 选择 **「属性」**
2. 在底部找到 **「安全」** 区域，勾选 **「解除锁定」**（Unblock）
3. 点击 **「确定」**，再双击安装

---

## 常见问题

### Q: 这样操作安全吗？

阿布是开源软件，可以在 GitHub 查看源代码。官方 macOS 包已签名并公证；Windows 提示来自安装包暂未取得 Authenticode 证书。选择「仍要运行」前，请确认文件来自官方 Release。

### Q: 每次更新都需要重新操作吗？

- **macOS**：不需要，官方更新会继续保持签名和公证。
- **Windows**：是否再次出现取决于 Windows 的信誉判断，新安装包仍可能触发提示。

### Q: 未来会解决这个问题吗？

macOS 签名和公证已经启用；取得合适证书后会再加入 Windows Authenticode 签名。
