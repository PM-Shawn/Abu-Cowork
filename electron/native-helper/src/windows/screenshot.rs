use crate::error::HelperError;
use std::collections::{HashMap, VecDeque};
use std::io::Cursor;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, TryRecvError};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use image::codecs::png::PngEncoder;
use image::{DynamicImage, ImageEncoder, RgbaImage};
use serde::Serialize;
use xcap::{Monitor, VideoRecorder};

use super::window::{
    get_window_impl, list_windows_impl, list_windows_z_order, window_is_owned_by, window_z_index,
    WindowRef,
};

const SCREENSHOT_CACHE_LIMIT: usize = 16;
const SCREENSHOT_TTL: Duration = Duration::from_secs(30);
static SCREENSHOT_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static SCREENSHOTS: OnceLock<Mutex<VecDeque<CachedScreenshot>>> = OnceLock::new();
static WGC_SESSIONS: OnceLock<Mutex<HashMap<String, WgcMonitorSession>>> = OnceLock::new();

struct WgcMonitorSession {
    _recorder: VideoRecorder,
    frames: Receiver<xcap::Frame>,
}

#[derive(Clone, Debug)]
pub struct CachedScreenshot {
    pub screenshot_id: String,
    pub created_at: Instant,
    pub app_id: Option<String>,
    pub process_id: Option<u32>,
    pub window_id: Option<String>,
    pub window_bounds: Option<[i32; 4]>,
    pub origin_x: i32,
    pub origin_y: i32,
    pub source_width: u32,
    pub source_height: u32,
    pub returned_width: u32,
    pub returned_height: u32,
    pub scale_factor: f64,
    pub input_epoch: u64,
}

#[derive(Debug, Serialize)]
pub struct ScreenshotResult {
    pub base64: String,
    pub width: u32,
    pub height: u32,
    pub scale_factor: f64,
    pub origin_x: f64,
    pub origin_y: f64,
    pub screenshot_id: String,
    pub monitor_id: String,
    pub z_index: i32,
    pub snapshot_revision: u64,
    pub input_epoch: u64,
}

fn cache() -> &'static Mutex<VecDeque<CachedScreenshot>> {
    SCREENSHOTS.get_or_init(|| Mutex::new(VecDeque::new()))
}

fn wgc_sessions() -> &'static Mutex<HashMap<String, WgcMonitorSession>> {
    WGC_SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn capture_next_monitor_frame(
    monitor: &Monitor,
    monitor_id: &str,
    input_epoch: u64,
) -> Result<RgbaImage, HelperError> {
    let mut sessions = wgc_sessions()
        .lock()
        .map_err(|_| HelperError::preflight("WGC session cache is unavailable"))?;
    if !sessions.contains_key(monitor_id) {
        let (recorder, frames) = monitor
            .video_recorder()
            .map_err(|error| HelperError::preflight(format!("WGC monitor session creation failed: {error}")))?;
        recorder
            .start()
            .map_err(|error| HelperError::preflight(format!("WGC monitor session start failed: {error}")))?;
        sessions.insert(
            monitor_id.to_string(),
            WgcMonitorSession {
                _recorder: recorder,
                frames,
            },
        );
    }
    let session = sessions
        .get_mut(monitor_id)
        .ok_or_else(|| HelperError::preflight("WGC monitor session disappeared"))?;
    let mut newest = None;
    loop {
        match session.frames.try_recv() {
            Ok(frame) => newest = Some(frame),
            Err(TryRecvError::Empty) => break,
            Err(TryRecvError::Disconnected) => {
                sessions.remove(monitor_id);
                return Err(HelperError::observe_again("capture-failed", "WGC monitor session disconnected; observe again"));
            }
        }
    }
    let started = Instant::now();
    let frame = if let Some(frame) = newest {
        frame
    } else {
        loop {
            if input_epoch != super::interaction::input_epoch() {
                return Err(HelperError::observe_again("physical-input", "physical user input occurred during capture; observe again"));
            }
            match session.frames.recv_timeout(Duration::from_millis(10)) {
                Ok(frame) => break frame,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout)
                    if started.elapsed() < Duration::from_secs(3) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    return Err(HelperError::observe_again("capture-failed", "WGC monitor frame wait timed out"));
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(HelperError::observe_again("capture-failed", "WGC monitor session disconnected; observe again"));
                }
            }
        }
    };
    RgbaImage::from_raw(frame.width, frame.height, frame.raw)
        .ok_or_else(|| HelperError::preflight("WGC monitor frame buffer is invalid"))
}

fn prune_cache(entries: &mut VecDeque<CachedScreenshot>) {
    while entries
        .front()
        .is_some_and(|entry| entry.created_at.elapsed() > SCREENSHOT_TTL)
    {
        entries.pop_front();
    }
    while entries.len() >= SCREENSHOT_CACHE_LIMIT {
        entries.pop_front();
    }
}

pub fn get_screenshot_ref(screenshot_id: &str) -> Result<CachedScreenshot, HelperError> {
    let mut entries = cache()
        .lock()
        .map_err(|_| HelperError::preflight("screenshot cache is unavailable"))?;
    prune_cache(&mut entries);
    entries
        .iter()
        .find(|entry| entry.screenshot_id == screenshot_id)
        .cloned()
        .ok_or_else(|| HelperError::observe_again("screenshot-stale", "screenshot_id is unknown or expired; observe again"))
}

fn target_window(
    expected_app_id: Option<&str>,
    expected_process_id: Option<u32>,
    expected_window_id: Option<&str>,
) -> Option<WindowRef> {
    let app_id = expected_app_id?;
    if let Some(window_id) = expected_window_id {
        let window = get_window_impl(window_id.to_string()).ok()?;
        if window.app_id.eq_ignore_ascii_case(app_id)
            && expected_process_id.is_none_or(|pid| pid == window.process_id)
        {
            return Some(window);
        }
        return None;
    }
    list_windows_impl(Some(app_id.to_string()))
        .ok()?
        .into_iter()
        .find(|window| expected_process_id.is_none_or(|pid| pid == window.process_id))
}

fn choose_monitor(
    target: Option<&WindowRef>,
    anchor_x: Option<f64>,
    anchor_y: Option<f64>,
) -> Result<Monitor, HelperError> {
    if let Some(window) = target {
        let x = window.bounds[0].saturating_add(window.bounds[2] / 2);
        let y = window.bounds[1].saturating_add(window.bounds[3] / 2);
        return Monitor::from_point(x, y)
            .map_err(|error| HelperError::preflight(format!("target monitor lookup failed: {error}")));
    }
    if let (Some(x), Some(y)) = (anchor_x, anchor_y) {
        return Monitor::from_point(x.round() as i32, y.round() as i32)
            .map_err(|error| HelperError::preflight(format!("anchor monitor lookup failed: {error}")));
    }
    let monitors =
        Monitor::all().map_err(|error| HelperError::preflight(format!("monitor enumeration failed: {error}")))?;
    monitors
        .iter()
        .find(|monitor| monitor.is_primary().unwrap_or(false))
        .cloned()
        .or_else(|| monitors.into_iter().next())
        .ok_or_else(|| HelperError::preflight("no monitor is available"))
}

#[allow(clippy::too_many_arguments)]
pub fn capture_screen_state_impl(
    x: Option<i32>,
    y: Option<i32>,
    width: Option<u32>,
    height: Option<u32>,
    max_width: Option<u32>,
    anchor_x: Option<f64>,
    anchor_y: Option<f64>,
    expected_app_id: Option<String>,
    expected_process_id: Option<u32>,
    expected_window_id: Option<String>,
) -> Result<ScreenshotResult, HelperError> {
    if !super::interaction::input_monitoring_ready() {
        return Err(HelperError::not_executed("input-lease", "physical input monitoring is unavailable; capture is blocked"));
    }
    let input_epoch = super::interaction::input_epoch();
    let target = target_window(
        expected_app_id.as_deref(),
        expected_process_id,
        expected_window_id.as_deref(),
    );
    if expected_app_id.is_some() && target.is_none() {
        return Err(HelperError::observe_again("window-not-found", "target window identity is unavailable for capture; observe again"));
    }
    let monitor = choose_monitor(target.as_ref(), anchor_x, anchor_y)?;
    let monitor_x = monitor
        .x()
        .map_err(|error| HelperError::preflight(format!("monitor x failed: {error}")))?;
    let monitor_y = monitor
        .y()
        .map_err(|error| HelperError::preflight(format!("monitor y failed: {error}")))?;
    let monitor_id = format!(
        "monitor:{}",
        monitor
            .id()
            .map_err(|error| HelperError::preflight(format!("monitor id failed: {error}")))?
    );
    let z_order = list_windows_z_order()?;
    let target_z_index = target
        .as_ref()
        .map(|target| window_z_index(&target.window_id))
        .transpose()?
        .unwrap_or(-1);
    let target_catalog_index = target.as_ref().and_then(|target| {
        z_order
            .iter()
            .position(|window| window.window_id == target.window_id)
    });
    let capture_bounds = target.as_ref().map(|target| {
        let mut left = target.bounds[0];
        let mut top = target.bounds[1];
        let mut right = left.saturating_add(target.bounds[2]);
        let mut bottom = top.saturating_add(target.bounds[3]);
        for popup in z_order
            .iter()
            .take(target_catalog_index.unwrap_or_default())
            .filter(|window| {
                window.process_id == target.process_id
                    && window_is_owned_by(&window.window_id, &target.window_id)
            })
        {
            left = left.min(popup.bounds[0]);
            top = top.min(popup.bounds[1]);
            right = right.max(popup.bounds[0].saturating_add(popup.bounds[2]));
            bottom = bottom.max(popup.bounds[1].saturating_add(popup.bounds[3]));
        }
        [
            left,
            top,
            right.saturating_sub(left),
            bottom.saturating_sub(top),
        ]
    });
    let image = capture_next_monitor_frame(&monitor, &monitor_id, input_epoch)?;
    if input_epoch != super::interaction::input_epoch() {
        return Err(HelperError::observe_again("physical-input", "physical user input occurred during capture; observe again"));
    }
    // With an exact target, default to the union of its physical-pixel
    // rectangle and owned top-level popups/menus above it. They are all cut
    // from this single WGC monitor frame. Explicit coordinates still permit a
    // caller-selected region.
    let default_x = capture_bounds
        .as_ref()
        .map(|bounds| bounds[0].saturating_sub(monitor_x))
        .unwrap_or_default();
    let default_y = capture_bounds
        .as_ref()
        .map(|bounds| bounds[1].saturating_sub(monitor_y))
        .unwrap_or_default();
    let crop_x = x.unwrap_or(default_x).max(0) as u32;
    let crop_y = y.unwrap_or(default_y).max(0) as u32;
    if crop_x >= image.width() || crop_y >= image.height() {
        return Err(HelperError::observe_again("capture-failed", "capture region origin is outside the target monitor"));
    }
    let default_width = capture_bounds
        .as_ref()
        .map(|bounds| bounds[2].max(0) as u32)
        .unwrap_or_else(|| image.width().saturating_sub(crop_x));
    let default_height = capture_bounds
        .as_ref()
        .map(|bounds| bounds[3].max(0) as u32)
        .unwrap_or_else(|| image.height().saturating_sub(crop_y));
    let crop_width = width
        .unwrap_or(default_width)
        .min(image.width().saturating_sub(crop_x));
    let crop_height = height
        .unwrap_or(default_height)
        .min(image.height().saturating_sub(crop_y));
    if crop_width == 0 || crop_height == 0 {
        return Err(HelperError::observe_again("capture-failed", "capture region is empty"));
    }
    let cropped = DynamicImage::from(image).crop_imm(crop_x, crop_y, crop_width, crop_height);
    let final_image = if let Some(limit) = max_width.filter(|value| *value > 0) {
        if cropped.width() > limit {
            let ratio = cropped.width() as f64 / limit as f64;
            let resized_height = (cropped.height() as f64 / ratio).round().max(1.0) as u32;
            cropped.resize(limit, resized_height, image::imageops::FilterType::Lanczos3)
        } else {
            cropped
        }
    } else {
        cropped
    };
    let returned_width = final_image.width();
    let returned_height = final_image.height();
    let scale_factor = crop_width as f64 / returned_width as f64;
    let mut png = Cursor::new(Vec::new());
    PngEncoder::new(&mut png)
        .write_image(
            final_image.as_bytes(),
            returned_width,
            returned_height,
            final_image.color().into(),
        )
        .map_err(|error| HelperError::preflight(format!("PNG encode failed: {error}")))?;
    let snapshot_revision = SCREENSHOT_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let screenshot_id = format!("shot-{}-{}", std::process::id(), snapshot_revision,);
    let origin_x = monitor_x.saturating_add(crop_x as i32);
    let origin_y = monitor_y.saturating_add(crop_y as i32);
    let cached = CachedScreenshot {
        screenshot_id: screenshot_id.clone(),
        created_at: Instant::now(),
        app_id: target.as_ref().map(|window| window.app_id.clone()),
        process_id: target.as_ref().map(|window| window.process_id),
        window_id: target.as_ref().map(|window| window.window_id.clone()),
        window_bounds: target.as_ref().map(|window| window.bounds),
        origin_x,
        origin_y,
        source_width: crop_width,
        source_height: crop_height,
        returned_width,
        returned_height,
        scale_factor,
        input_epoch,
    };
    let mut entries = cache()
        .lock()
        .map_err(|_| HelperError::preflight("screenshot cache is unavailable"))?;
    prune_cache(&mut entries);
    entries.push_back(cached);
    Ok(ScreenshotResult {
        base64: BASE64.encode(png.into_inner()),
        width: returned_width,
        height: returned_height,
        scale_factor,
        origin_x: origin_x as f64,
        origin_y: origin_y as f64,
        screenshot_id,
        monitor_id,
        z_index: target_z_index,
        snapshot_revision,
        input_epoch,
    })
}
