use serde::{Deserialize, Serialize};

/// Line ending style.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LineEnding {
    Lf,
    CrLf,
}

impl LineEnding {
    pub fn as_str(&self) -> &'static str {
        match self {
            LineEnding::Lf => "\n",
            LineEnding::CrLf => "\r\n",
        }
    }
}

/// Configuration for a vault.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VaultConfig {
    pub name: String,
    pub attachment_dir: String,
    pub line_ending: LineEnding,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub exclude_dirs: Vec<String>,
    #[serde(default)]
    pub show_hidden: bool,
}

impl Default for VaultConfig {
    fn default() -> Self {
        VaultConfig {
            name: "Untitled".into(),
            attachment_dir: "assets".into(),
            line_ending: LineEnding::Lf,
            exclude_dirs: Vec::new(),
            show_hidden: false,
        }
    }
}

/// A vault is a directory of markdown notes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Vault {
    pub path: String,
    pub config: VaultConfig,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_line_ending_as_str() {
        assert_eq!(LineEnding::Lf.as_str(), "\n");
        assert_eq!(LineEnding::CrLf.as_str(), "\r\n");
    }

    #[test]
    fn test_vault_config_default() {
        let cfg = VaultConfig::default();
        assert_eq!(cfg.name, "Untitled");
        assert_eq!(cfg.attachment_dir, "assets");
        assert_eq!(cfg.line_ending, LineEnding::Lf);
        assert!(cfg.exclude_dirs.is_empty());
        assert!(!cfg.show_hidden);
    }
}
