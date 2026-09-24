use crate::error::HelperError;
use std::collections::{HashMap, VecDeque};
use std::io::Cursor;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
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
    /// Newest frame the session has produced; written by the pump thread on
    /// every FrameArrived and never drained, so a static screen keeps its
    /// last change available.
    latest: Arc<Mutex<Option<xcap::Frame>>>,
    /// Set by the pump thread when xcap's channel disconnects (session lost).
    disconnected: Arc<AtomicBool>,
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
    /// Monitor layout at capture time (dpi::display_signature).
    pub display_signature: u64,
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
    /// How many other applications' windows were painted out of this frame.
    /// Reported so the model is told why part of the image is blank rather
    /// than left to interpret a grey rectangle as something it can act on.
    pub masked_window_count: u32,
    pub snapshot_revision: u64,
    pub input_epoch: u64,
}

/// What a masked-out region is filled with. Flat and dark, so the model reads
/// it as an absence rather than mistaking it for a panel it could act on.
const MASK_FILL: [u8; 4] = [28, 28, 30, 255];

/// Rectangles, in monitor-local pixels, of windows stacked above the target
/// that belong to another process.
///
/// A window capture is cut from a whole-monitor frame, so anything overlapping
/// the target survives the crop. Input cannot land on those windows —
/// `assert_point` hit-tests every coordinate and refuses with `occluded` — but
/// a screenshot has no such defence: the pixels simply arrive at the model. A
/// session authorized for one application must not get to read another one's
/// screen, so they are painted out here, the one place that sees both the
/// frame and the window stack.
///
/// The target's own process is never masked: its owned menus and popups are
/// part of what the session was granted, and they are already unioned into the
/// capture bounds.
fn occluding_rects(
    z_order: &[WindowRef],
    target: &WindowRef,
    target_catalog_index: usize,
    monitor_x: i32,
    monitor_y: i32,
) -> Vec<[i32; 4]> {
    z_order
        .iter()
        .take(target_catalog_index)
        .filter(|window| {
            window.process_id != target.process_id
                && !window.minimized
                // A window that is on no frame cannot be hiding anything in
                // one. Abu's own Computer Use chrome is the case that forced
                // this: full-display, always-on-top, content-protected, and
                // owned by another process than the target, so the rule above
                // matched it and painted every capture flat.
                && !window.absent_from_capture
        })
        .map(|window| {
            [
                window.bounds[0].saturating_sub(monitor_x),
                window.bounds[1].saturating_sub(monitor_y),
                window.bounds[2],
                window.bounds[3],
            ]
        })
        .filter(|rect| rect[2] > 0 && rect[3] > 0)
        .collect()
}

/// Fills each rectangle in place, clamped to the frame. Returns how many
/// actually covered any pixels, which is what the caller reports — a mask that
/// fell entirely outside the frame did not hide anything from anyone.
fn apply_mask(image: &mut RgbaImage, rects: &[[i32; 4]]) -> u32 {
    let frame_width = image.width() as i64;
    let frame_height = image.height() as i64;
    let mut masked = 0u32;
    for rect in rects {
        let left = i64::from(rect[0]).max(0);
        let top = i64::from(rect[1]).max(0);
        let right = (i64::from(rect[0]) + i64::from(rect[2])).min(frame_width);
        let bottom = (i64::from(rect[1]) + i64::from(rect[3])).min(frame_height);
        if right <= left || bottom <= top {
            continue;
        }
        masked += 1;
        for y in top..bottom {
            for x in left..right {
                image.put_pixel(x as u32, y as u32, image::Rgba(MASK_FILL));
            }
        }
    }
    masked
}

fn cache() -> &'static Mutex<VecDeque<CachedScreenshot>> {
    SCREENSHOTS.get_or_init(|| Mutex::new(VecDeque::new()))
}

fn wgc_sessions() -> &'static Mutex<HashMap<String, WgcMonitorSession>> {
    WGC_SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The newest frame of a monitor, from a session that is kept running.
///
/// xcap hands frames over a rendezvous channel: its FrameArrived handler
/// blocks in `send` until someone receives, and once the pool's two buffers
/// are held by blocked handlers WGC produces nothing more. Draining that
/// channel only at capture time therefore returned the first change after the
/// *previous* capture, never the screen as it is now (measured 2026-09-12: a
/// full-width bar shown for 1.2 s did not appear in the frame at all). A pump
/// thread per session receives continuously and keeps only the newest frame,
/// so the pool never stalls and a static screen's last change is what a
/// capture returns.
fn capture_next_monitor_frame(
    monitor: &Monitor,
    monitor_id: &str,
    input_epoch: u64,
) -> Result<RgbaImage, HelperError> {
    let (latest, disconnected) = {
        let mut sessions = wgc_sessions()
            .lock()
            .map_err(|_| HelperError::preflight("WGC session cache is unavailable"))?;
        if sessions
            .get(monitor_id)
            .is_some_and(|session| session.disconnected.load(Ordering::Acquire))
        {
            sessions.remove(monitor_id);
        }
        if !sessions.contains_key(monitor_id) {
            let (recorder, frames) = monitor
                .video_recorder()
                .map_err(|error| HelperError::preflight(format!("WGC monitor session creation failed: {error}")))?;
            recorder
                .start()
                .map_err(|error| HelperError::preflight(format!("WGC monitor session start failed: {error}")))?;
            let latest = Arc::new(Mutex::new(None));
            let disconnected = Arc::new(AtomicBool::new(false));
            let sink = Arc::clone(&latest);
            let gone = Arc::clone(&disconnected);
            thread::Builder::new()
                .name(format!("wgc-pump-{monitor_id}"))
                .spawn(move || {
                    while let Ok(frame) = frames.recv() {
                        if let Ok(mut slot) = sink.lock() {
                            *slot = Some(frame);
                        }
                    }
                    gone.store(true, Ordering::Release);
                })
                .map_err(|error| HelperError::preflight(format!("WGC frame pump failed: {error}")))?;
            sessions.insert(
                monitor_id.to_string(),
                WgcMonitorSession {
                    _recorder: recorder,
                    latest,
                    disconnected,
                },
            );
        }
        let session = sessions
            .get(monitor_id)
            .ok_or_else(|| HelperError::preflight("WGC monitor session disappeared"))?;
        (Arc::clone(&session.latest), Arc::clone(&session.disconnected))
    };
    let started = Instant::now();
    let frame = loop {
        if input_epoch != super::interaction::input_epoch() {
            return Err(HelperError::observe_again("physical-input", "physical user input occurred during capture; observe again"));
        }
        if disconnected.load(Ordering::Acquire) {
            return Err(HelperError::observe_again("capture-failed", "WGC monitor session disconnected; observe again"));
        }
        let newest = latest.lock().ok().and_then(|slot| slot.clone());
        if let Some(frame) = newest {
            break frame;
        }
        if started.elapsed() >= Duration::from_secs(3) {
            return Err(HelperError::observe_again("capture-failed", "WGC monitor frame wait timed out"));
        }
        thread::sleep(Duration::from_millis(10));
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
    let current_display = super::dpi::display_signature()?;
    let mut entries = cache()
        .lock()
        .map_err(|_| HelperError::preflight("screenshot cache is unavailable"))?;
    prune_cache(&mut entries);
    let entry = entries
        .iter()
        .find(|entry| entry.screenshot_id == screenshot_id)
        .cloned()
        .ok_or_else(|| HelperError::observe_again("screenshot-stale", "screenshot_id is unknown or expired; observe again"))?;
    if entry.display_signature != current_display {
        return Err(HelperError::observe_again(
            "screenshot-stale",
            "display configuration changed after the screenshot; observe again",
        ));
    }
    Ok(entry)
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
    super::session::assert_session_usable()?;
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
    let mut image = capture_next_monitor_frame(&monitor, &monitor_id, input_epoch)?;
    if input_epoch != super::interaction::input_epoch() {
        return Err(HelperError::observe_again("physical-input", "physical user input occurred during capture; observe again"));
    }
    // Only a window-scoped capture is masked. A whole-screen capture has no
    // target to be scoped to and is authorized separately, by a user who asked
    // to see the whole screen; masking it would defeat what they asked for.
    let masked_window_count = match (target.as_ref(), target_catalog_index) {
        (Some(target), Some(index)) => {
            let rects = occluding_rects(&z_order, target, index, monitor_x, monitor_y);
            apply_mask(&mut image, &rects)
        }
        _ => 0,
    };
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
    let display_signature = super::dpi::display_signature()?;
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
        display_signature,
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
        masked_window_count,
        snapshot_revision,
        input_epoch,
    })
}

#[cfg(test)]
mod tests {
    use super::{apply_mask, occluding_rects, RgbaImage, WindowRef, MASK_FILL};

    fn window(process_id: u32, bounds: [i32; 4], minimized: bool) -> WindowRef {
        WindowRef {
            app_id: format!("app-{process_id}"),
            app_name: format!("app-{process_id}"),
            window_id: format!("hwnd:{process_id}-{}", bounds[0]),
            process_id,
            title: String::new(),
            bounds,
            executable_path: String::new(),
            minimized,
            signature_status: "unknown".to_string(),
            signer_subject: None,
            package_full_name: None,
            absent_from_capture: false,
        }
    }

    /// Regression: Abu's own Computer Use chrome is a full-display, always-on-top
    /// window owned by the Electron main process, so the "different process,
    /// above the target" rule matched it and painted the entire frame flat —
    /// every window capture during a session returned a solid rectangle. It is
    /// also content-protected, so its pixels were never in the frame to begin
    /// with: masking it destroyed the target's pixels to hide nothing.
    #[test]
    fn a_window_that_cannot_appear_in_the_frame_never_masks_the_target() {
        let target = window(100, [200, 200, 400, 300], false);
        let mut chrome = window(4242, [0, 0, 2560, 1440], false);
        chrome.absent_from_capture = true;
        let z_order = vec![chrome, target.clone()];
        let rects = occluding_rects(&z_order, &target, 1, 0, 0);
        assert!(rects.is_empty(), "content-protected chrome must not mask: {rects:?}");

        let mut image = RgbaImage::from_pixel(2560, 1440, image::Rgba([9, 9, 9, 255]));
        assert_eq!(apply_mask(&mut image, &rects), 0);
        assert_ne!(image.get_pixel(600, 500).0, MASK_FILL, "target pixels survived");
    }

    #[test]
    fn only_other_apps_stacked_above_the_target_are_masked() {
        let target = window(100, [200, 200, 400, 300], false);
        let z_order = vec![
            window(999, [0, 0, 100, 100], false),   // another app, above
            window(100, [180, 180, 60, 60], false), // the target's own menu, above
            window(888, [0, 0, 50, 50], true),      // another app, above, minimized
            target.clone(),
            window(777, [0, 0, 80, 80], false), // another app, but behind
        ];
        let rects = occluding_rects(&z_order, &target, 3, 0, 0);
        // The target's own popup stays: it is part of what the session was
        // granted. The minimized window is not on screen. The window behind
        // cannot be covering anything.
        assert_eq!(rects, vec![[0, 0, 100, 100]]);
    }

    #[test]
    fn rects_are_translated_into_monitor_local_pixels() {
        let target = window(100, [2000, 100, 400, 300], false);
        let z_order = vec![window(999, [1920, 0, 200, 200], false), target.clone()];
        // The target lives on a second monitor whose origin is (1920, 0).
        let rects = occluding_rects(&z_order, &target, 1, 1920, 0);
        assert_eq!(rects, vec![[0, 0, 200, 200]]);
    }

    #[test]
    fn a_whole_screen_capture_has_no_target_so_nothing_is_masked() {
        // Guarded by the caller rather than here, but the shape matters: with
        // the target at index 0 there is nothing stacked above it.
        let target = window(100, [0, 0, 400, 300], false);
        let z_order = vec![target.clone(), window(999, [0, 0, 100, 100], false)];
        assert!(occluding_rects(&z_order, &target, 0, 0, 0).is_empty());
    }

    #[test]
    fn masking_fills_only_the_overlap_and_counts_what_it_covered() {
        let mut image = RgbaImage::from_pixel(10, 10, image::Rgba([255, 255, 255, 255]));
        let covered = apply_mask(
            &mut image,
            &[
                [2, 2, 3, 3],       // inside
                [8, 8, 50, 50],     // runs off the edge, still covers pixels
                [-40, -40, 10, 10], // entirely off the frame
                [100, 0, 5, 5],     // entirely off the frame
            ],
        );
        assert_eq!(covered, 2);
        assert_eq!(image.get_pixel(3, 3).0, MASK_FILL);
        assert_eq!(image.get_pixel(9, 9).0, MASK_FILL);
        assert_eq!(image.get_pixel(0, 0).0, [255, 255, 255, 255]);
        assert_eq!(image.get_pixel(5, 5).0, [255, 255, 255, 255]);
    }

    #[test]
    fn a_negative_origin_still_masks_the_part_that_is_on_screen() {
        // A window half off the left edge of the monitor must not leave its
        // visible half unmasked.
        let mut image = RgbaImage::from_pixel(6, 6, image::Rgba([255, 255, 255, 255]));
        assert_eq!(apply_mask(&mut image, &[[-3, -3, 6, 6]]), 1);
        assert_eq!(image.get_pixel(0, 0).0, MASK_FILL);
        assert_eq!(image.get_pixel(2, 2).0, MASK_FILL);
        assert_eq!(image.get_pixel(3, 3).0, [255, 255, 255, 255]);
    }
}
