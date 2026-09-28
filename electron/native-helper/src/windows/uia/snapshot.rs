use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use windows::Win32::System::Ole::{
    SafeArrayDestroy, SafeArrayGetDim, SafeArrayGetElement, SafeArrayGetLBound, SafeArrayGetUBound,
};
use windows::Win32::UI::Accessibility::{
    ExpandCollapseState_Collapsed, ExpandCollapseState_Expanded, ExpandCollapseState_LeafNode,
    ExpandCollapseState_PartiallyExpanded, IUIAutomation, IUIAutomationCacheRequest,
    IUIAutomationElement, IUIAutomationExpandCollapsePattern, IUIAutomationInvokePattern,
    IUIAutomationRangeValuePattern, IUIAutomationScrollItemPattern, IUIAutomationScrollPattern,
    IUIAutomationSelectionItemPattern, IUIAutomationTextPattern, IUIAutomationTogglePattern,
    IUIAutomationValuePattern, IUIAutomationWindowPattern, ToggleState_Indeterminate,
    ToggleState_Off, ToggleState_On, TreeScope_Element, UIA_AppBarControlTypeId,
    UIA_AutomationIdPropertyId, UIA_BoundingRectanglePropertyId, UIA_ButtonControlTypeId,
    UIA_CalendarControlTypeId, UIA_CheckBoxControlTypeId, UIA_ClassNamePropertyId,
    UIA_ComboBoxControlTypeId, UIA_ControlTypePropertyId, UIA_CustomControlTypeId,
    UIA_DataGridControlTypeId, UIA_DataItemControlTypeId, UIA_DocumentControlTypeId,
    UIA_EditControlTypeId, UIA_ExpandCollapsePatternId, UIA_GroupControlTypeId,
    UIA_HasKeyboardFocusPropertyId, UIA_HeaderControlTypeId, UIA_HeaderItemControlTypeId,
    UIA_HyperlinkControlTypeId, UIA_ImageControlTypeId, UIA_InvokePatternId,
    UIA_IsEnabledPropertyId, UIA_IsKeyboardFocusablePropertyId, UIA_IsOffscreenPropertyId,
    UIA_IsPasswordPropertyId, UIA_ListControlTypeId, UIA_ListItemControlTypeId,
    UIA_MenuBarControlTypeId, UIA_MenuControlTypeId, UIA_MenuItemControlTypeId, UIA_NamePropertyId,
    UIA_NativeWindowHandlePropertyId, UIA_PaneControlTypeId, UIA_ProcessIdPropertyId,
    UIA_ProgressBarControlTypeId, UIA_RadioButtonControlTypeId, UIA_RangeValuePatternId,
    UIA_ScrollBarControlTypeId, UIA_ScrollItemPatternId, UIA_ScrollPatternId,
    UIA_SelectionItemPatternId, UIA_SeparatorControlTypeId, UIA_SliderControlTypeId,
    UIA_SpinnerControlTypeId, UIA_SplitButtonControlTypeId, UIA_StatusBarControlTypeId,
    UIA_TabControlTypeId, UIA_TabItemControlTypeId, UIA_TableControlTypeId, UIA_TextControlTypeId,
    UIA_TextPatternId, UIA_ThumbControlTypeId, UIA_TitleBarControlTypeId, UIA_TogglePatternId,
    UIA_ToolBarControlTypeId, UIA_ToolTipControlTypeId, UIA_TreeControlTypeId,
    UIA_TreeItemControlTypeId, UIA_ValuePatternId, UIA_WindowControlTypeId, UIA_WindowPatternId,
};
use windows::Win32::UI::Accessibility::{
    UIA_ExpandCollapseExpandCollapseStatePropertyId, UIA_RangeValueIsReadOnlyPropertyId,
    UIA_RangeValueLargeChangePropertyId, UIA_RangeValueMaximumPropertyId,
    UIA_RangeValueMinimumPropertyId, UIA_RangeValueSmallChangePropertyId,
    UIA_RangeValueValuePropertyId, UIA_ScrollHorizontalScrollPercentPropertyId,
    UIA_ScrollHorizontalViewSizePropertyId, UIA_ScrollHorizontallyScrollablePropertyId,
    UIA_ScrollVerticalScrollPercentPropertyId, UIA_ScrollVerticalViewSizePropertyId,
    UIA_ScrollVerticallyScrollablePropertyId, UIA_SelectionItemIsSelectedPropertyId,
    UIA_ToggleToggleStatePropertyId, UIA_ValueIsReadOnlyPropertyId, UIA_ValueValuePropertyId,
};

use super::super::window::{hwnd_id, window_has_owner};
use super::cache::{CachedElement, UiaSession};
use super::types::{RangeValueState, ScrollState, UiElement};

const MAX_VISITED: usize = 1_200;
const MAX_RETURNED: usize = 800;
const MAX_DEPTH: u32 = 24;
const MAX_TEXT_CHARS: usize = 32_000;
const MAX_DURATION: Duration = Duration::from_millis(3_000);

pub struct SnapshotBuild {
    pub session: UiaSession,
    pub total_visited: usize,
    pub truncated: bool,
    pub focused_element_id: Option<u32>,
    pub modal: bool,
    pub modal_window_id: Option<String>,
}

struct WalkState {
    process_id: u32,
    started: Instant,
    total_visited: usize,
    text_chars: usize,
    truncated: bool,
    next_id: u32,
    elements: HashMap<u32, CachedElement>,
    public_elements: Vec<UiElement>,
    focused_element_id: Option<u32>,
    input_epoch: u64,
    modal_detected: bool,
    modal_window_id: Option<String>,
    modal_element_ids: HashSet<u32>,
}

struct PatternState {
    actions: Vec<String>,
    patterns: Vec<String>,
    value_read_only: Option<bool>,
    range_value: Option<RangeValueState>,
    toggle_state: Option<String>,
    selected: Option<bool>,
    expand_collapse_state: Option<String>,
    scroll_state: Option<ScrollState>,
}

fn clean_text(value: String, max_chars: usize) -> Option<String> {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        return None;
    }
    Some(normalized.chars().take(max_chars).collect())
}

fn role_name(control_type: i32) -> &'static str {
    match control_type {
        x if x == UIA_ButtonControlTypeId.0 => "Button",
        x if x == UIA_CalendarControlTypeId.0 => "Calendar",
        x if x == UIA_CheckBoxControlTypeId.0 => "CheckBox",
        x if x == UIA_ComboBoxControlTypeId.0 => "ComboBox",
        x if x == UIA_EditControlTypeId.0 => "TextField",
        x if x == UIA_HyperlinkControlTypeId.0 => "Link",
        x if x == UIA_ImageControlTypeId.0 => "Image",
        x if x == UIA_ListItemControlTypeId.0 => "ListItem",
        x if x == UIA_ListControlTypeId.0 => "List",
        x if x == UIA_MenuControlTypeId.0 => "Menu",
        x if x == UIA_MenuBarControlTypeId.0 => "MenuBar",
        x if x == UIA_MenuItemControlTypeId.0 => "MenuItem",
        x if x == UIA_ProgressBarControlTypeId.0 => "ProgressBar",
        x if x == UIA_RadioButtonControlTypeId.0 => "RadioButton",
        x if x == UIA_ScrollBarControlTypeId.0 => "ScrollBar",
        x if x == UIA_SliderControlTypeId.0 => "Slider",
        x if x == UIA_SpinnerControlTypeId.0 => "Spinner",
        x if x == UIA_StatusBarControlTypeId.0 => "StatusBar",
        x if x == UIA_TabControlTypeId.0 => "Tab",
        x if x == UIA_TabItemControlTypeId.0 => "TabItem",
        x if x == UIA_TextControlTypeId.0 => "Text",
        x if x == UIA_ToolBarControlTypeId.0 => "ToolBar",
        x if x == UIA_TreeControlTypeId.0 => "Tree",
        x if x == UIA_TreeItemControlTypeId.0 => "TreeItem",
        x if x == UIA_WindowControlTypeId.0 => "Window",
        x if x == UIA_DocumentControlTypeId.0 => "Document",
        x if x == UIA_PaneControlTypeId.0 => "Pane",
        x if x == UIA_GroupControlTypeId.0 => "Group",
        x if x == UIA_DataGridControlTypeId.0 => "DataGrid",
        x if x == UIA_DataItemControlTypeId.0 => "DataItem",
        x if x == UIA_TableControlTypeId.0 => "Table",
        x if x == UIA_HeaderControlTypeId.0 => "Header",
        x if x == UIA_HeaderItemControlTypeId.0 => "HeaderItem",
        x if x == UIA_ThumbControlTypeId.0 => "Thumb",
        x if x == UIA_TitleBarControlTypeId.0 => "TitleBar",
        x if x == UIA_ToolTipControlTypeId.0 => "ToolTip",
        x if x == UIA_SeparatorControlTypeId.0 => "Separator",
        x if x == UIA_SplitButtonControlTypeId.0 => "SplitButton",
        x if x == UIA_AppBarControlTypeId.0 => "AppBar",
        x if x == UIA_CustomControlTypeId.0 => "Custom",
        _ => "Control",
    }
}

pub(super) fn runtime_id_for_validation(element: &IUIAutomationElement) -> Vec<i32> {
    let array = match unsafe { element.GetRuntimeId() } {
        Ok(value) if !value.is_null() => value,
        _ => return Vec::new(),
    };
    let result = (|| {
        if unsafe { SafeArrayGetDim(array) } != 1 {
            return Vec::new();
        }
        let lower = unsafe { SafeArrayGetLBound(array, 1) }.unwrap_or(0);
        let upper = unsafe { SafeArrayGetUBound(array, 1) }.unwrap_or(-1);
        let mut values = Vec::with_capacity(upper.saturating_sub(lower) as usize + 1);
        for index in lower..=upper {
            let mut value = 0i32;
            if unsafe { SafeArrayGetElement(array, &index, (&mut value as *mut i32).cast()) }
                .is_ok()
            {
                values.push(value);
            }
        }
        values
    })();
    let _ = unsafe { SafeArrayDestroy(array) };
    result
}

/// Opaque wire identity for an element: a 64-bit FNV-1a of its UIA RuntimeId.
/// Stable for the element's lifetime within its process — exactly what UIA
/// promises for the runtime id — and never parsed upstream, only compared.
pub(super) fn element_ref(runtime_id: &[i32]) -> Option<String> {
    if runtime_id.is_empty() {
        return None;
    }
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for value in runtime_id {
        for byte in value.to_le_bytes() {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    Some(format!("e:{hash:016x}"))
}

fn focused_element_for_restore(
    automation: &IUIAutomation,
    process_id: u32,
) -> Option<CachedElement> {
    let native = unsafe { automation.GetFocusedElement() }.ok()?;
    let actual_process = unsafe { native.CurrentProcessId() }.ok()?;
    if actual_process != process_id as i32 {
        return None;
    }
    let runtime_id = runtime_id_for_validation(&native);
    if runtime_id.is_empty() {
        return None;
    }
    let rect = unsafe { native.CurrentBoundingRectangle() }.ok()?;
    Some(CachedElement {
        native,
        runtime_id,
        process_id,
        bounds: [
            rect.left as f64,
            rect.top as f64,
            rect.right.saturating_sub(rect.left) as f64,
            rect.bottom.saturating_sub(rect.top) as f64,
        ],
    })
}

fn pattern_state(element: &IUIAutomationElement) -> PatternState {
    let mut actions = Vec::new();
    let mut patterns = Vec::new();
    let mut value_read_only = None;
    let mut range_value = None;
    let mut toggle_state = None;
    let mut selected = None;
    let mut expand_collapse_state = None;
    let mut scroll_state = None;
    unsafe {
        if element
            .GetCachedPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
            .is_ok()
        {
            patterns.push("Invoke".to_string());
            actions.push("Invoke".to_string());
        }
        if let Ok(pattern) =
            element.GetCachedPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
        {
            patterns.push("Value".to_string());
            let read_only = pattern
                .CachedIsReadOnly()
                .map_or(true, |value| value.as_bool());
            value_read_only = Some(read_only);
            if !read_only {
                actions.push("SetValue".to_string());
            }
        }
        if let Ok(pattern) =
            element.GetCachedPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId)
        {
            patterns.push("Toggle".to_string());
            actions.push("Toggle".to_string());
            toggle_state = pattern.CachedToggleState().ok().map(|state| {
                if state == ToggleState_Off {
                    "off"
                } else if state == ToggleState_On {
                    "on"
                } else if state == ToggleState_Indeterminate {
                    "indeterminate"
                } else {
                    "unknown"
                }
                .to_string()
            });
        }
        if let Ok(pattern) = element
            .GetCachedPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId)
        {
            patterns.push("SelectionItem".to_string());
            actions.push("Select".to_string());
            selected = pattern.CachedIsSelected().ok().map(|value| value.as_bool());
        }
        if let Ok(pattern) = element
            .GetCachedPatternAs::<IUIAutomationExpandCollapsePattern>(UIA_ExpandCollapsePatternId)
        {
            patterns.push("ExpandCollapse".to_string());
            actions.push("ExpandCollapse".to_string());
            expand_collapse_state = pattern.CachedExpandCollapseState().ok().map(|state| {
                if state == ExpandCollapseState_Collapsed {
                    "collapsed"
                } else if state == ExpandCollapseState_Expanded {
                    "expanded"
                } else if state == ExpandCollapseState_PartiallyExpanded {
                    "partially-expanded"
                } else if state == ExpandCollapseState_LeafNode {
                    "leaf"
                } else {
                    "unknown"
                }
                .to_string()
            });
        }
        if let Ok(pattern) =
            element.GetCachedPatternAs::<IUIAutomationRangeValuePattern>(UIA_RangeValuePatternId)
        {
            patterns.push("RangeValue".to_string());
            let read_only = pattern
                .CachedIsReadOnly()
                .map_or(true, |value| value.as_bool());
            range_value = Some(RangeValueState {
                value: pattern.CachedValue().unwrap_or_default(),
                minimum: pattern.CachedMinimum().unwrap_or_default(),
                maximum: pattern.CachedMaximum().unwrap_or_default(),
                small_change: pattern.CachedSmallChange().unwrap_or_default(),
                large_change: pattern.CachedLargeChange().unwrap_or_default(),
                read_only,
            });
            if !read_only {
                actions.push("SetRangeValue".to_string());
            }
        }
        if element
            .GetCachedPatternAs::<IUIAutomationScrollItemPattern>(UIA_ScrollItemPatternId)
            .is_ok()
        {
            patterns.push("ScrollItem".to_string());
            actions.push("ScrollIntoView".to_string());
        }
        if let Ok(pattern) =
            element.GetCachedPatternAs::<IUIAutomationScrollPattern>(UIA_ScrollPatternId)
        {
            patterns.push("Scroll".to_string());
            actions.push("Scroll".to_string());
            scroll_state = Some(ScrollState {
                horizontally_scrollable: pattern
                    .CachedHorizontallyScrollable()
                    .map_or(false, |value| value.as_bool()),
                horizontal_scroll_percent: pattern
                    .CachedHorizontalScrollPercent()
                    .unwrap_or_default(),
                horizontal_view_size: pattern.CachedHorizontalViewSize().unwrap_or_default(),
                vertically_scrollable: pattern
                    .CachedVerticallyScrollable()
                    .map_or(false, |value| value.as_bool()),
                vertical_scroll_percent: pattern.CachedVerticalScrollPercent().unwrap_or_default(),
                vertical_view_size: pattern.CachedVerticalViewSize().unwrap_or_default(),
            });
        }
    }
    PatternState {
        actions,
        patterns,
        value_read_only,
        range_value,
        toggle_state,
        selected,
        expand_collapse_state,
        scroll_state,
    }
}

fn is_modal_window(native: &IUIAutomationElement, cached: &IUIAutomationElement) -> bool {
    unsafe {
        if cached
            .CachedControlType()
            .map(|value| value.0)
            .unwrap_or_default()
            != UIA_WindowControlTypeId.0
        {
            return false;
        }
        let provider_modal = native
            .GetCurrentPatternAs::<IUIAutomationWindowPattern>(UIA_WindowPatternId)
            .ok()
            .and_then(|pattern| pattern.CurrentIsModal().ok())
            .is_some_and(|value| value.as_bool());
        if provider_modal {
            return true;
        }
        // Office's NUIDialog provider reports WindowPattern.IsModal=false even
        // while Windows has disabled its owner and blocks the document behind
        // it. The Win32 owner relation is authoritative for this top-level
        // popup, and prevents the model from receiving clickable-looking
        // background controls that the OS will reject.
        cached
            .CachedNativeWindowHandle()
            .ok()
            .filter(|hwnd| !hwnd.0.is_null())
            .is_some_and(|hwnd| window_has_owner(&hwnd_id(hwnd)))
    }
}

/// Text that a pattern reports as present: empty stays `Some("")`, so a
/// cleared field is distinguishable from a control with no value pattern.
fn present_text(raw: String, max_chars: usize) -> Option<String> {
    Some(clean_text(raw, max_chars).unwrap_or_default())
}

fn value(element: &IUIAutomationElement) -> Option<String> {
    if unsafe { element.CachedIsPassword() }.map_or(true, |value| value.as_bool()) {
        return None;
    }
    if let Ok(pattern) =
        unsafe { element.GetCachedPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) }
    {
        return present_text(unsafe { pattern.CachedValue() }.ok()?.to_string(), 2_000);
    }
    if let Ok(pattern) =
        unsafe { element.GetCachedPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId) }
    {
        let range = unsafe { pattern.DocumentRange() }.ok()?;
        return present_text(unsafe { range.GetText(2_000) }.ok()?.to_string(), 2_000);
    }
    let range = unsafe {
        element.GetCachedPatternAs::<IUIAutomationRangeValuePattern>(UIA_RangeValuePatternId)
    }
    .ok()?;
    unsafe { range.CachedValue() }
        .ok()
        .map(|value| value.to_string())
}

fn collect_element(
    native: &IUIAutomationElement,
    cached: &IUIAutomationElement,
    depth: u32,
    inside_modal: bool,
    state: &mut WalkState,
) {
    if unsafe { cached.CachedProcessId() }.unwrap_or_default() != state.process_id as i32 {
        return;
    }
    let enabled = unsafe { cached.CachedIsEnabled() }.map_or(false, |value| value.as_bool());
    let offscreen = unsafe { cached.CachedIsOffscreen() }.map_or(true, |value| value.as_bool());
    let focused = unsafe { cached.CachedHasKeyboardFocus() }.map_or(false, |value| value.as_bool());
    let label = unsafe { cached.CachedName() }
        .ok()
        .and_then(|value| clean_text(value.to_string(), 1_000));
    let element_value = value(cached);
    let mut pattern_state = pattern_state(cached);
    let keyboard_focusable =
        unsafe { cached.CachedIsKeyboardFocusable() }.map_or(false, |value| value.as_bool());
    if keyboard_focusable && pattern_state.actions.is_empty() {
        pattern_state.actions.push("Focus".to_string());
    }
    let control_type = unsafe { cached.CachedControlType() }
        .map(|value| value.0)
        .unwrap_or_default();
    let role = role_name(control_type).to_string();
    let is_text = matches!(role.as_str(), "Text" | "Document");
    let useful = !pattern_state.patterns.is_empty()
        || keyboard_focusable
        || (is_text && (label.is_some() || element_value.is_some()))
        || matches!(
            role.as_str(),
            "TextField" | "ComboBox" | "ListItem" | "MenuItem" | "TabItem" | "TreeItem"
        );
    if !useful || state.public_elements.len() >= MAX_RETURNED {
        if state.public_elements.len() >= MAX_RETURNED {
            state.truncated = true;
        }
        return;
    }
    let rect = unsafe { cached.CachedBoundingRectangle() }.unwrap_or_default();
    let bounds = [
        rect.left as f64,
        rect.top as f64,
        rect.right.saturating_sub(rect.left) as f64,
        rect.bottom.saturating_sub(rect.top) as f64,
    ];
    let added_chars =
        label.as_ref().map_or(0, String::len) + element_value.as_ref().map_or(0, String::len);
    if state.text_chars.saturating_add(added_chars) > MAX_TEXT_CHARS {
        state.truncated = true;
        return;
    }
    state.text_chars += added_chars;
    let id = state.next_id;
    state.next_id += 1;
    if focused {
        state.focused_element_id = Some(id);
    }
    let automation_id = unsafe { cached.CachedAutomationId() }
        .ok()
        .and_then(|value| clean_text(value.to_string(), 512));
    let class_name = unsafe { cached.CachedClassName() }
        .ok()
        .and_then(|value| clean_text(value.to_string(), 512));
    let runtime_id = runtime_id_for_validation(native);
    state.public_elements.push(UiElement {
        id,
        element_ref: element_ref(&runtime_id),
        role,
        label,
        value: element_value,
        value_read_only: pattern_state.value_read_only,
        range_value: pattern_state.range_value,
        toggle_state: pattern_state.toggle_state,
        selected: pattern_state.selected,
        expand_collapse_state: pattern_state.expand_collapse_state,
        scroll_state: pattern_state.scroll_state,
        bounds,
        patterns: pattern_state.patterns,
        actions: pattern_state.actions,
        depth,
        automation_id,
        class_name,
        enabled,
        offscreen,
        focused,
    });
    state.elements.insert(
        id,
        CachedElement {
            native: native.clone(),
            runtime_id,
            process_id: state.process_id,
            bounds,
        },
    );
    if inside_modal {
        state.modal_element_ids.insert(id);
    }
}

fn create_cache_request(automation: &IUIAutomation) -> Result<IUIAutomationCacheRequest, String> {
    let request = unsafe { automation.CreateCacheRequest() }
        .map_err(|error| format!("UIA CreateCacheRequest failed: {error}"))?;
    unsafe { request.SetTreeScope(TreeScope_Element) }
        .map_err(|error| format!("UIA cache scope failed: {error}"))?;
    for property in [
        UIA_ProcessIdPropertyId,
        UIA_NativeWindowHandlePropertyId,
        UIA_ControlTypePropertyId,
        UIA_NamePropertyId,
        UIA_AutomationIdPropertyId,
        UIA_ClassNamePropertyId,
        UIA_BoundingRectanglePropertyId,
        UIA_IsEnabledPropertyId,
        UIA_IsKeyboardFocusablePropertyId,
        UIA_IsOffscreenPropertyId,
        UIA_HasKeyboardFocusPropertyId,
        UIA_IsPasswordPropertyId,
        UIA_ValueValuePropertyId,
        UIA_ValueIsReadOnlyPropertyId,
        UIA_RangeValueValuePropertyId,
        UIA_RangeValueIsReadOnlyPropertyId,
        UIA_RangeValueMinimumPropertyId,
        UIA_RangeValueMaximumPropertyId,
        UIA_RangeValueSmallChangePropertyId,
        UIA_RangeValueLargeChangePropertyId,
        UIA_ToggleToggleStatePropertyId,
        UIA_SelectionItemIsSelectedPropertyId,
        UIA_ExpandCollapseExpandCollapseStatePropertyId,
        UIA_ScrollHorizontallyScrollablePropertyId,
        UIA_ScrollHorizontalScrollPercentPropertyId,
        UIA_ScrollHorizontalViewSizePropertyId,
        UIA_ScrollVerticallyScrollablePropertyId,
        UIA_ScrollVerticalScrollPercentPropertyId,
        UIA_ScrollVerticalViewSizePropertyId,
    ] {
        unsafe { request.AddProperty(property) }
            .map_err(|error| format!("UIA cache property failed: {error}"))?;
    }
    for pattern in [
        UIA_InvokePatternId,
        UIA_ValuePatternId,
        UIA_TextPatternId,
        UIA_TogglePatternId,
        UIA_SelectionItemPatternId,
        UIA_ExpandCollapsePatternId,
        UIA_RangeValuePatternId,
        UIA_ScrollItemPatternId,
        UIA_ScrollPatternId,
    ] {
        unsafe { request.AddPattern(pattern) }
            .map_err(|error| format!("UIA cache pattern failed: {error}"))?;
    }
    Ok(request)
}

fn walk(
    automation: &IUIAutomation,
    cache_request: &IUIAutomationCacheRequest,
    element: IUIAutomationElement,
    depth: u32,
    inside_modal: bool,
    state: &mut WalkState,
) -> Result<(), String> {
    if state.input_epoch != super::super::interaction::input_epoch() {
        return Err("physical user input occurred during observation; observe again".to_string());
    }
    if depth > MAX_DEPTH
        || state.total_visited >= MAX_VISITED
        || state.started.elapsed() >= MAX_DURATION
    {
        state.truncated = true;
        return Ok(());
    }
    state.total_visited += 1;
    let cached = unsafe { element.BuildUpdatedCache(cache_request) }
        .map_err(|error| format!("UIA BuildUpdatedCache failed: {error}"))?;
    let current_is_modal = is_modal_window(&element, &cached);
    let inside_modal = inside_modal || current_is_modal;
    if current_is_modal {
        state.modal_detected = true;
        if state.modal_window_id.is_none() {
            state.modal_window_id = unsafe { cached.CachedNativeWindowHandle() }
                .ok()
                .filter(|hwnd| !hwnd.0.is_null())
                .map(|hwnd| hwnd_id(hwnd));
        }
    }
    collect_element(&element, &cached, depth, inside_modal, state);
    let walker = unsafe { automation.ControlViewWalker() }
        .map_err(|error| format!("UIA ControlViewWalker failed: {error}"))?;
    let mut child = unsafe { walker.GetFirstChildElement(&element) }.ok();
    while let Some(current) = child {
        if state.input_epoch != super::super::interaction::input_epoch() {
            return Err(
                "physical user input occurred during observation; observe again".to_string(),
            );
        }
        walk(
            automation,
            cache_request,
            current.clone(),
            depth + 1,
            inside_modal,
            state,
        )?;
        if state.truncated
            && (state.total_visited >= MAX_VISITED || state.started.elapsed() >= MAX_DURATION)
        {
            break;
        }
        child = unsafe { walker.GetNextSiblingElement(&current) }.ok();
    }
    Ok(())
}

pub fn build_snapshot(
    automation: &IUIAutomation,
    root: IUIAutomationElement,
    app_id: String,
    process_id: u32,
    window_id: String,
) -> Result<SnapshotBuild, String> {
    if !super::super::interaction::input_monitoring_ready() {
        return Err("physical input monitoring is unavailable; observation is blocked".to_string());
    }
    let input_epoch = super::super::interaction::input_epoch();
    let cache_request = create_cache_request(automation)?;
    let mut state = WalkState {
        process_id,
        started: Instant::now(),
        total_visited: 0,
        text_chars: 0,
        truncated: false,
        next_id: 0,
        elements: HashMap::new(),
        public_elements: Vec::new(),
        focused_element_id: None,
        input_epoch,
        modal_detected: false,
        modal_window_id: None,
        modal_element_ids: HashSet::new(),
    };
    walk(automation, &cache_request, root, 0, false, &mut state)?;
    if input_epoch != super::super::interaction::input_epoch() {
        return Err("physical user input occurred during observation; observe again".to_string());
    }
    if state.modal_detected {
        state
            .public_elements
            .retain(|element| state.modal_element_ids.contains(&element.id));
        state
            .elements
            .retain(|element_id, _| state.modal_element_ids.contains(element_id));
        state.focused_element_id = state
            .focused_element_id
            .filter(|element_id| state.modal_element_ids.contains(element_id));
    }
    // Keep the OS-reported focus target even when Office exposes it as a
    // custom/non-useful UIA node that is intentionally omitted from the public
    // bounded tree. This opaque handle never crosses the Helper boundary.
    let focused_element = focused_element_for_restore(automation, process_id);
    Ok(SnapshotBuild {
        session: UiaSession {
            app_id,
            process_id,
            window_id,
            elements: state.elements,
            focused_element,
            public_elements: state.public_elements,
            input_epoch,
        },
        total_visited: state.total_visited,
        truncated: state.truncated,
        focused_element_id: state.focused_element_id,
        modal: state.modal_detected,
        modal_window_id: state.modal_window_id,
    })
}

#[cfg(test)]
mod element_ref_tests {
    use super::{element_ref, present_text};

    #[test]
    fn present_text_keeps_an_empty_value_distinct_from_no_value() {
        assert_eq!(present_text(String::new(), 10), Some(String::new()));
        assert_eq!(present_text("   ".to_string(), 10), Some(String::new()));
        assert_eq!(present_text(" a  b ".to_string(), 10), Some("a b".to_string()));
        assert_eq!(present_text("abcdef".to_string(), 3), Some("abc".to_string()));
    }

    #[test]
    fn element_ref_is_opaque_deterministic_and_order_sensitive() {
        assert_eq!(element_ref(&[]), None);
        let a = element_ref(&[42, 7, -1]).unwrap();
        assert_eq!(a, element_ref(&[42, 7, -1]).unwrap());
        assert_ne!(a, element_ref(&[7, 42, -1]).unwrap());
        assert_ne!(a, element_ref(&[42, 7]).unwrap());
        assert!(a.starts_with("e:"));
        assert_eq!(a.len(), 18);
        assert!(a[2..].chars().all(|c| c.is_ascii_hexdigit()));
    }
}
