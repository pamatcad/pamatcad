use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    NotFound,
    PreviewUnavailable,
    InvalidParameter,
    InvalidState,
    AmbiguousRegion,
    AmbiguousFace,
    UnsupportedProfile,
    KernelFailure,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct CoreError {
    pub code: ErrorCode,
    pub message: String,
}

impl CoreError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for CoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for CoreError {}
pub type Result<T> = std::result::Result<T, CoreError>;
