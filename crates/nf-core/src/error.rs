use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("invalid span: start={start} > end={end}")]
    InvalidSpan { start: usize, end: usize },

    #[error("serde error: {0}")]
    Serde(#[from] serde_json::Error),
}
