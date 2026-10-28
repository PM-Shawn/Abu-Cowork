use std::sync::mpsc;
use std::time::{Duration, Instant};

use image::RgbaImage;
use windows_collections::IIterable;
use windows_wgc::core::{factory, Interface};
use windows_wgc::Foundation::TypedEventHandler;
use windows_wgc::Foundation::Metadata::ApiInformation;
use windows_wgc::Graphics::Capture::{Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession};
use windows_wgc::Graphics::DirectX::{Direct3D11::IDirect3DDevice, DirectXPixelFormat};
use windows_wgc::Win32::Foundation::{HMODULE, POINT};
use windows_wgc::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows_wgc::Win32::Graphics::Direct3D11::*;
use windows_wgc::Win32::Graphics::Dxgi::IDXGIDevice;
use windows_wgc::Win32::Graphics::Gdi::{MonitorFromPoint, MONITOR_DEFAULTTONEAREST};
use windows_wgc::Win32::System::WinRT::Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess};
use windows_wgc::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;

use super::capture_bindings::{IDirect3D11CaptureFrame3, IDisplayGraphicsCaptureSession, WindowId};
use crate::error::HelperError;

struct CaptureSession {
    device: ID3D11Device,
    pool: Direct3D11CaptureFramePool,
    session: GraphicsCaptureSession,
}

impl Drop for CaptureSession {
    fn drop(&mut self) {
        self.session.Close().expect("capture session close failed");
        self.pool.Close().expect("capture pool close failed");
    }
}

fn open(monitor: &xcap::Monitor) -> Result<CaptureSession, HelperError> {
    let x = monitor.x().map_err(|error| HelperError::preflight(format!("monitor x failed: {error}")))?;
    let y = monitor.y().map_err(|error| HelperError::preflight(format!("monitor y failed: {error}")))?;
    let handle = unsafe { MonitorFromPoint(POINT { x, y }, MONITOR_DEFAULTTONEAREST) };
    let mut device = None;
    unsafe {
        D3D11CreateDevice(None, D3D_DRIVER_TYPE_HARDWARE, HMODULE::default(), D3D11_CREATE_DEVICE_BGRA_SUPPORT, None, D3D11_SDK_VERSION, Some(&mut device), None, None)
            .map_err(|error| HelperError::preflight(format!("capture device failed: {error}")))?;
    }
    let device = device.ok_or_else(|| HelperError::preflight("capture device unavailable"))?;
    let dxgi: IDXGIDevice = device.cast().map_err(|error| HelperError::preflight(format!("capture device conversion failed: {error}")))?;
    let direct3d: IDirect3DDevice = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi) }
        .and_then(|value| value.cast())
        .map_err(|error| HelperError::preflight(format!("capture device conversion failed: {error}")))?;
    let interop: IGraphicsCaptureItemInterop = factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()
        .map_err(|error| HelperError::preflight(format!("capture factory failed: {error}")))?;
    let item: GraphicsCaptureItem = unsafe { interop.CreateForMonitor(handle) }
        .map_err(|error| HelperError::preflight(format!("monitor capture item failed: {error}")))?;
    let size = item.Size().map_err(|error| HelperError::preflight(format!("capture size failed: {error}")))?;
    let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(&direct3d, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, size)
        .map_err(|error| HelperError::preflight(format!("capture pool failed: {error}")))?;
    let session = pool.CreateCaptureSession(&item)
        .map_err(|error| HelperError::preflight(format!("capture session failed: {error}")))?;
    Ok(CaptureSession { device, pool, session })
}

pub fn supports_exclusion() -> Result<bool, HelperError> {
    let interface_available = ApiInformation::IsTypePresent(&windows_wgc::core::HSTRING::from(
        "Windows.Graphics.Capture.IDisplayGraphicsCaptureSession",
    )).map_err(|error| HelperError::preflight(format!("capture exclusion type check failed: {error}")))?;
    let version_available = ApiInformation::IsPropertyPresent(
        &windows_wgc::core::HSTRING::from("Windows.Graphics.Capture.Direct3D11CaptureFrame"),
        &windows_wgc::core::HSTRING::from("ConfigurationIteration"),
    ).map_err(|error| HelperError::preflight(format!("capture frame version check failed: {error}")))?;
    if !interface_available || !version_available { return Ok(false); }
    let monitor = xcap::Monitor::all()
        .map_err(|error| HelperError::preflight(format!("monitor enumeration failed: {error}")))?
        .into_iter().next().ok_or_else(|| HelperError::preflight("no monitor is available"))?;
    let capture = open(&monitor)?;
    let result = match capture.session.cast::<IDisplayGraphicsCaptureSession>() {
        Ok(_) => true,
        Err(error) if error.code().0 == 0x80004002u32 as i32 => false,
        Err(error) => return Err(HelperError::preflight(format!("capture exclusion capability failed: {error}"))),
    };
    Ok(result)
}

pub fn capture_excluding(monitor: &xcap::Monitor, window_id: u64, input_epoch: u64) -> Result<RgbaImage, HelperError> {
    let capture = open(monitor)?;
    let display: IDisplayGraphicsCaptureSession = capture.session.cast()
        .map_err(|error| HelperError::preflight(format!("capture exclusion unavailable: {error}")))?;
    let excluded: IIterable<WindowId> = vec![WindowId { Value: window_id }].into();
    let version = display.SetWindowExclusionList(&excluded)
        .map_err(|error| HelperError::preflight(format!("capture exclusion failed: {error}")))?;
    let (sender, receiver) = mpsc::channel();
    let token = capture.pool.FrameArrived(&TypedEventHandler::new(move |pool: windows_wgc::core::Ref<'_, Direct3D11CaptureFramePool>, _| {
        let pool = pool.as_ref().ok_or_else(|| windows_wgc::core::Error::from(windows_wgc::core::HRESULT(0x80004003u32 as i32)))?;
        let frame = pool.TryGetNextFrame()?;
        sender.send(frame).map_err(|_| windows_wgc::core::Error::from(windows_wgc::core::HRESULT(0x80004005u32 as i32)))?;
        Ok(())
    })).map_err(|error| HelperError::preflight(format!("capture frame subscription failed: {error}")))?;
    capture.session.SetIsCursorCaptureEnabled(false)
        .map_err(|error| HelperError::preflight(format!("capture cursor setting failed: {error}")))?;
    capture.session.SetIsBorderRequired(false)
        .map_err(|error| HelperError::preflight(format!("capture border setting failed: {error}")))?;
    capture.session.StartCapture().map_err(|error| HelperError::preflight(format!("capture start failed: {error}")))?;
    let start = Instant::now();
    let frame = loop {
        if input_epoch != super::interaction::input_epoch() {
            return Err(HelperError::observe_again("physical-input", "physical user input occurred during capture; observe again"));
        }
        let remaining = Duration::from_secs(3).checked_sub(start.elapsed())
            .ok_or_else(|| HelperError::observe_again("capture-failed", "capture frame wait timed out"))?;
        let frame = receiver.recv_timeout(remaining)
            .map_err(|error| HelperError::observe_again("capture-failed", format!("capture frame wait failed: {error}")))?;
        let frame3: IDirect3D11CaptureFrame3 = frame.cast()
            .map_err(|error| HelperError::preflight(format!("capture frame version unavailable: {error}")))?;
        let mut iteration = 0;
        unsafe { (frame3.vtable().ConfigurationIteration)(frame3.as_raw(), &mut iteration).ok() }
            .map_err(|error| HelperError::preflight(format!("capture frame version failed: {error}")))?;
        if iteration >= version { break frame; }
        frame.Close().map_err(|error| HelperError::preflight(format!("capture frame close failed: {error}")))?;
    };
    let access: IDirect3DDxgiInterfaceAccess = frame.Surface().and_then(|surface| surface.cast())
        .map_err(|error| HelperError::preflight(format!("capture surface failed: {error}")))?;
    let source: ID3D11Texture2D = unsafe { access.GetInterface() }
        .map_err(|error| HelperError::preflight(format!("capture texture failed: {error}")))?;
    let mut desc = D3D11_TEXTURE2D_DESC::default();
    unsafe { source.GetDesc(&mut desc); }
    let content_size = frame.ContentSize()
        .map_err(|error| HelperError::preflight(format!("capture content size failed: {error}")))?;
    validate_frame_size(content_size.Width, content_size.Height, desc.Width, desc.Height)?;
    desc.BindFlags = 0;
    desc.MiscFlags = 0;
    desc.Usage = D3D11_USAGE_STAGING;
    desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
    let mut staging = None;
    unsafe { capture.device.CreateTexture2D(&desc, None, Some(&mut staging)) }
        .map_err(|error| HelperError::preflight(format!("capture texture creation failed: {error}")))?;
    let destination: ID3D11Resource = staging.ok_or_else(|| HelperError::preflight("capture texture unavailable"))?
        .cast().map_err(|error| HelperError::preflight(format!("capture texture conversion failed: {error}")))?;
    let source_resource: ID3D11Resource = source.cast()
        .map_err(|error| HelperError::preflight(format!("capture texture conversion failed: {error}")))?;
    let context = unsafe { capture.device.GetImmediateContext() }
        .map_err(|error| HelperError::preflight(format!("capture context failed: {error}")))?;
    unsafe { context.CopyResource(&destination, &source_resource); }
    let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
    unsafe { context.Map(Some(&destination), 0, D3D11_MAP_READ, 0, Some(&mut mapped)) }
        .map_err(|error| HelperError::preflight(format!("capture texture map failed: {error}")))?;
    let mut pixels = vec![0u8; desc.Width as usize * desc.Height as usize * 4];
    for row in 0..desc.Height as usize {
        let source_row = unsafe { std::slice::from_raw_parts((mapped.pData as *const u8).add(row * mapped.RowPitch as usize), desc.Width as usize * 4) };
        let target = &mut pixels[row * desc.Width as usize * 4..(row + 1) * desc.Width as usize * 4];
        target.copy_from_slice(source_row);
        for pixel in target.chunks_exact_mut(4) { pixel.swap(0, 2); }
    }
    unsafe { context.Unmap(Some(&destination), 0); }
    frame.Close().map_err(|error| HelperError::preflight(format!("capture frame close failed: {error}")))?;
    capture.pool.RemoveFrameArrived(token).map_err(|error| HelperError::preflight(format!("capture subscription close failed: {error}")))?;
    RgbaImage::from_raw(desc.Width, desc.Height, pixels).ok_or_else(|| HelperError::preflight("capture frame buffer is invalid"))
}

fn validate_frame_size(width: i32, height: i32, texture_width: u32, texture_height: u32) -> Result<(), HelperError> {
    if width <= 0 || height <= 0 || width as u32 != texture_width || height as u32 != texture_height {
        return Err(HelperError::observe_again("display-changed", "capture content size changed; observe again"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::validate_frame_size;

    #[test]
    fn changed_or_empty_content_cannot_be_returned_as_a_complete_monitor_frame() {
        assert!(validate_frame_size(1920, 1080, 1920, 1080).is_ok());
        assert!(validate_frame_size(1280, 720, 1920, 1080).is_err());
        assert!(validate_frame_size(2560, 1440, 1920, 1080).is_err());
        assert!(validate_frame_size(0, 0, 1920, 1080).is_err());
        assert!(validate_frame_size(-1, 1080, 1920, 1080).is_err());
    }
}
