console.error([
  '',
  '[Abu] Tauri 已退出功能开发与验收链路。',
  '请使用 Electron：',
  '  OSS：      npm run electron:dev',
  '  企业版：   npm run electron:dev:enterprise',
  '',
  'src-tauri/ 仅为已发布旧版本兼容、数据迁移与回退证据保留；',
  '不要在 Tauri 上开发或验收新功能。',
  '',
].join('\n'));

process.exitCode = 1;
