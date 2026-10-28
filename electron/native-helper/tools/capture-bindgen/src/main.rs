use std::path::Path;

fn main() {
    let metadata = std::env::args().nth(1).expect("pass the Windows SDK or system WinMetadata directory");
    let output = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../src/windows/capture_bindings.rs");
    windows_bindgen::bindgen([
        "--in",
        &metadata,
        "--out",
        output.to_str().expect("binding output path must be UTF-8"),
        "--flat",
        "--filter",
        "Windows.Graphics.Capture.IDisplayGraphicsCaptureSession",
        "Windows.Graphics.Capture.IDirect3D11CaptureFrame3",
        "Windows.UI.WindowId",
    ]).unwrap();
}
