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

    #[error("认证失败: {0}")]
    AuthFailed(String),

    #[error("未找到: {0}")]
    NotFound(String),

    #[error("解密失败: {0}")]
    DecryptFailed(String),

    #[error("配置错误: {0}")]
    Config(String),

    #[error("远端已存在其他数据: {0}")]
    RemoteNotEmpty(String),

    #[error("{0}")]
    Other(String),
}

impl From<String> for SyncError {
    fn from(s: String) -> Self { SyncError::Other(s) }
}

impl From<&str> for SyncError {
    fn from(s: &str) -> Self { SyncError::Other(s.to_string()) }
}

impl From<nf_crypto::CryptoError> for SyncError {
    fn from(e: nf_crypto::CryptoError) -> Self {
        SyncError::DecryptFailed(e.to_string())
    }
}
