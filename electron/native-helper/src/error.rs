//! Structured helper errors — the wire answer to "did this reach the app?".
//!
//! Every failure the helper reports carries three facts the upper tiers must
//! never infer from prose: a stable `code`, an `execution` verdict (was
//! anything dispatched to the target before the failure), and whether a fresh
//! observation is likely to make the same request succeed (`retryable`). The
//! Host Gate decides safe-retry vs. hand-off from these fields only; `message`
//! is for logs and people.
//!
//! Classification happens where the error is raised, because only that code
//! knows whether input has already been sent. Legacy `String` errors convert
//! to `internal` + `outcome-unknown` — the pessimistic default — unless the
//! raising site wraps them with [`HelperError::preflight`], which asserts that
//! nothing had been dispatched yet.

use serde::Serialize;
use serde_json::Value;
use std::fmt;

/// What the helper knows about the request's effect on the target application.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Execution {
    /// Failed before any input or call reached the target; a retry cannot
    /// duplicate a side effect.
    NotExecuted,
    /// Fully delivered to the target; the failure is about what came after.
    Dispatched,
    /// Partially delivered, or delivery state is unknowable.
    OutcomeUnknown,
}

/// Unclassified failure. The Host resolves its execution verdict from the
/// command kind (observation → not executed, stateful → outcome unknown).
pub const CODE_INTERNAL: &str = "internal";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HelperError {
    pub code: &'static str,
    pub execution: Execution,
    pub retryable: bool,
    pub message: String,
}

impl HelperError {
    /// Refused before touching the target; a plain retry will fail the same way.
    pub fn not_executed(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            execution: Execution::NotExecuted,
            retryable: false,
            message: message.into(),
        }
    }

    /// Refused before touching the target because the observed world moved on;
    /// observing again and choosing afresh is the right recovery.
    pub fn observe_again(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            execution: Execution::NotExecuted,
            retryable: true,
            message: message.into(),
        }
    }

    /// Delivered in full; the failure concerns a follow-up check.
    pub fn dispatched(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            execution: Execution::Dispatched,
            retryable: false,
            message: message.into(),
        }
    }

    /// Partially delivered or unknowable; replaying could double a side effect.
    pub fn outcome_unknown(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            execution: Execution::OutcomeUnknown,
            retryable: false,
            message: message.into(),
        }
    }

    /// Unclassified failure at an unknown point — the pessimistic default.
    pub fn internal(message: impl Into<String>) -> Self {
        Self::outcome_unknown(CODE_INTERNAL, message)
    }

    /// Unclassified failure that the raising site knows happened before any
    /// dispatch (lookups, validation, capture). Keeps `internal` as the code so
    /// nobody mistakes "not classified" for "classified".
    pub fn preflight(message: impl Into<String>) -> Self {
        Self::not_executed(CODE_INTERNAL, message)
    }

    /// Re-stamp an error raised after input was already sent: whatever it said
    /// about itself, the request as a whole is now outcome-unknown.
    pub fn after_dispatch(mut self) -> Self {
        self.execution = Execution::OutcomeUnknown;
        self.retryable = false;
        self
    }

    pub fn to_json(&self) -> Value {
        serde_json::to_value(self).unwrap_or_else(|_| Value::String(self.message.clone()))
    }
}

impl From<String> for HelperError {
    fn from(message: String) -> Self {
        Self::internal(message)
    }
}

impl From<&str> for HelperError {
    fn from(message: &str) -> Self {
        Self::internal(message)
    }
}

/// Lossy bridge for code paths that still speak `String`; the structure is
/// gone after this, so prefer converting the caller instead.
impl From<HelperError> for String {
    fn from(error: HelperError) -> Self {
        error.message
    }
}

impl fmt::Display for HelperError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for HelperError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_the_wire_shape() {
        let error = HelperError::observe_again("target-changed", "frontmost target changed");
        assert_eq!(
            error.to_json(),
            serde_json::json!({
                "code": "target-changed",
                "execution": "not-executed",
                "retryable": true,
                "message": "frontmost target changed",
            })
        );
    }

    #[test]
    fn legacy_strings_default_to_the_pessimistic_verdict() {
        let error: HelperError = "boom".to_string().into();
        assert_eq!(error.code, CODE_INTERNAL);
        assert_eq!(error.execution, Execution::OutcomeUnknown);
        assert!(!error.retryable);

        let preflight = HelperError::preflight("lookup failed");
        assert_eq!(preflight.code, CODE_INTERNAL);
        assert_eq!(preflight.execution, Execution::NotExecuted);
    }

    #[test]
    fn after_dispatch_overrides_any_earlier_verdict() {
        let error = HelperError::observe_again("physical-input", "interrupted").after_dispatch();
        assert_eq!(error.execution, Execution::OutcomeUnknown);
        assert!(!error.retryable);
        assert_eq!(error.code, "physical-input");
    }
}
