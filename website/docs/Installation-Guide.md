# Abu 安装指南

[English](Installation-Guide_EN.md) | **中文**

## 下载

前往 [GitHub Releases](https://github.com/PM-Shawn/Abu-Cowork/releases) 下载对应平台的安装包：

| 平台 | 文件格式 |
|------|----------|
| macOS (Apple Silicon) | `Abu_x.x.x_aarch64.dmg` |
| macOS (Intel) | `Abu_x.x.x_x64.dmg` |
| Windows | `Abu_x.x.x_x64-setup.exe` |

---

## macOS 安装

### 1. 安装应用

双击 `.dmg` 文件，将 Abu 拖入 `Applications` 文件夹。

### 2. 处理"已损坏，无法打开"提示

由于 Abu 目前未进行 Apple 签名和公证，首次打开时 macOS 会弹出以下提示：

> "Abu"已损坏，无法打开。你应该将它移到废纸篓。

**解决方法：**

打开「终端」（在启动台搜索"终端"或"Terminal"），输入以下命令：

```bash
xattr -cr /Applications/Abu.app
```

按回车执行，然后再次双击打开 Abu 即可。

> **提示**：如果你把 Abu 放在了其他位置，将 `/Applications/Abu.app` 替换为实际路径。也可以输入 `xattr -cr ` 后直接把 Abu.app 拖入终端窗口，路径会自动填充。

### 3. 备选方法

如果上述命令无效，可以尝试：

```bash
sudo spctl --master-disable
```

这会临时关闭 Gatekeeper。安装完成后建议重新启用：

```bash
sudo spctl --master-enable
```

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

Abu 是开源软件，你可以在 GitHub 上查看全部源代码。上述提示是因为应用未购买商业代码签名证书，并非应用本身有问题。

### Q: 每次更新都需要重新操作吗？

- **macOS**：是的，每次更新后需要重新执行 `xattr -cr` 命令。
- **Windows**：通常只有首次运行需要放行 SmartScreen。

### Q: 未来会解决这个问题吗？

计划在正式发布时购买代码签名证书（macOS Apple Developer + Windows EV 证书），届时将不再出现安全提示。
