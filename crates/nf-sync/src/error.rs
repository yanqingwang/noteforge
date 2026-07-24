use thiserror::Error;

#[derive(Error, Debug)]
pub enum SyncError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("URL parse error: {0}")]
    Url(#[from] url::ParseError),

    #[error("Auth failed: {0}")]
    AuthFailed(String),

    #[error("Delta cursor expired, full resync required")]
    ResyncRequired,

    #[error("Not found: {0}")]
    NotFound(String),

    #[error("Conflict: {0}")]
    Conflict(String),

    #[error("{0}")]
    Other(String),
}

impl From<String> for SyncError {
    fn from(s: String) -> Self { SyncError::Other(s) }
}