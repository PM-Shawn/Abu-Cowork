# Windows 截图接口绑定

`src/windows/capture_bindings.rs` 由 Microsoft `windows-bindgen` 生成。常规编译直接使用已生成的绑定。

重新生成需要包含 `IDisplayGraphicsCaptureSession` 和 `Direct3D11CaptureFrame.ConfigurationIteration` 的 Windows metadata。在具有这些接口的 Windows 上，从仓库根目录执行：

```powershell
cargo run --manifest-path electron/native-helper/tools/capture-bindgen/Cargo.toml -- C:/Windows/System32/WinMetadata
```

也可以将最后的路径替换为包含这些接口的 Windows SDK metadata 目录。生成器的版本固定在 `Cargo.toml` 中，生成结果应纳入代码审查。
