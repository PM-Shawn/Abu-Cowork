# Fork 与二次分发指南

**中文** | [English](FORKING.md)

阿布采用 Apache-2.0 开源协议。你可以修改和二次分发本仓库，但修改版桌面包不能冒充阿布官方发行版，也不能使用阿布生产更新通道。

## 本地开发

```bash
npm ci
npm run setup:electron-dev
npm run electron:dev
```

开发数据与正式安装版隔离。本地可使用 `npm run dist:electron` 生成安装包；准备分发时，必须在实际运行它的操作系统和 CPU 架构上完成验证。

## 默认安全边界

基础 `electron-builder.yml` 默认设置：

- `abuRelease.officialBuild: false`：打包态自动更新保持关闭；
- `abuRelease.tauriMigration: false`：不读取或迁移用户已安装的官方阿布数据；
- `publish: null`：不嵌入官方更新源，也不自动推断其他更新源。

只有官方 `PM-Shawn/Abu-Cowork` 发布工作流可以同时覆盖这三个控制项。Fork 不应复制官方构建标记或 OSS 地址。

## 分发修改版前

请使用不会与官方阿布冲突的身份：

1. 修改 `electron-builder.yml` 中的 `appId` 和 `productName`；
2. 修改 `abu://` 协议名称、scheme 及全部对应处理器；
3. 使用独立的用户数据目录和 updater cache 名称；
4. 按需替换图标、版权、支持链接和安装包名称；
5. 配置自己控制的更新源，或者继续关闭自动更新。

如果保留 `com.abu.app`、`Abu` 产品名或官方数据目录，两个独立构建的应用可能共享系统注册、快捷方式、卸载身份或本地数据。

## 签名和发布工作流

下列官方签名与发布秘密不会进入公开仓库：

- Apple Developer ID 证书和 App Store Connect 公证密钥；
- 仅用于 v0.34 框架切换的 Tauri 更新签名密钥；
- 阿里云 OSS 官方更新源凭据；
- Windows Authenticode 凭据（当前官方 Windows 包仍未签名）。

Tag 触发的生产发布只允许官方仓库执行。Fork 维护者需要自行准备发布工作流、应用身份、签名、产物存储、更新源和回滚方案。Windows 测试包可以保持未签名，但必须向用户说明 SmartScreen 提示。

## Open-core 边界

本公开仓库只包含个人版代码，以及公开的企业接口和空实现。不得把私有企业实现、凭据、客户配置或 `.env.local` 内容放入 fork 或 Pull Request。具体边界见 [`docs/ENTERPRISE-BUILD.md`](docs/ENTERPRISE-BUILD.md)。

