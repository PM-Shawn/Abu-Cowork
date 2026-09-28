use std::collections::HashMap;

use windows::Win32::UI::Accessibility::IUIAutomationElement;

use super::types::UiElement;

pub struct CachedElement {
    pub native: IUIAutomationElement,
    pub runtime_id: Vec<i32>,
    pub process_id: u32,
    pub bounds: [f64; 4],
}

pub struct UiaSession {
    pub app_id: String,
    pub process_id: u32,
    pub window_id: String,
    pub elements: HashMap<u32, CachedElement>,
    pub focused_element: Option<CachedElement>,
    pub public_elements: Vec<UiElement>,
    pub input_epoch: u64,
}

impl UiaSession {
    pub fn element(&self, element_id: u32) -> Result<&CachedElement, String> {
        self.elements
            .get(&element_id)
            .ok_or_else(|| format!("UIA element {element_id} is unavailable; observe again"))
    }
}
