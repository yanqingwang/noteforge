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

/// Encryption mode for vault content.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EncryptMode {
    /// Only encrypt note content; metadata (TOC, links, tags) stays plain.
    ContentOnly,
    /// Encrypt everything including metadata.
    Full,
}

/// How pasted images are referenced in markdown.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttachmentLinkStyle {
    /// `![[path]]` (default; NoteForge's native form).
    Wikilink,
    /// `![alt](path)` (standard Markdown, Obsidian-style).
    Markdown,
}

impl Default for AttachmentLinkStyle {
    fn default() -> Self {
        AttachmentLinkStyle::Wikilink
    }
}

/// Naming scheme for pasted attachment files.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttachmentNameStyle {
    /// `YYYYMMDDHHmmss` (default).
    Timestamp,
    /// `img-<epoch_ms>-<seq>` (Obsidian-style).
    Sequence,
}

impl Default for AttachmentNameStyle {
    fn default() -> Self {
        AttachmentNameStyle::Timestamp
    }
}

/// How image bytes are loaded for display.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImageRenderMode {
    /// Inline base64 data URL via `read_file_data` (default).
    Data,
    /// `asset://` custom protocol (requires assetProtocol enabled).
    Asset,
}

impl Default for ImageRenderMode {
    fn default() -> Self {
        ImageRenderMode::Data
    }
}

/// How the image link path is written in the note.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttachmentLinkFormat {
    /// Full vault-relative path (default; `attachments/2026-10/x.png`).
    Absolute,
    /// Relative to the current note's folder (`../attachments/x.png`).
    Relative,
    /// Just the file name when it is unique in the vault (`x.png`).
    Shortest,
}

impl Default for AttachmentLinkFormat {
    fn default() -> Self {
        AttachmentLinkFormat::Absolute
    }
}

fn default_true() -> bool {
    true
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
    /// Whether the vault is encrypted.
    #[serde(default)]
    pub encrypted: bool,
    /// Argon2id password hash (base64), present only when encrypted=true.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password_hash: Option<String>,
    /// Key derivation salt (base64), present only when encrypted=true.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub salt: Option<String>,
    /// Encryption mode, defaults to ContentOnly.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encrypt_mode: Option<EncryptMode>,
    /// Markdown style used when inserting pasted images.
    #[serde(default)]
    pub attachment_link_style: AttachmentLinkStyle,
    /// Whether pasted images go into a `YYYY-MM/` subfolder of `attachment_dir`.
    #[serde(default = "default_true")]
    pub attachment_subfolder: bool,
    /// Naming scheme for pasted image files.
    #[serde(default)]
    pub attachment_name_style: AttachmentNameStyle,
    /// How image bytes are loaded for display.
    #[serde(default)]
    pub image_render_mode: ImageRenderMode,
    /// How the inserted image link path is written.
    #[serde(default)]
    pub attachment_link_format: AttachmentLinkFormat,
    /// Convert pasted raster images to WebP before saving.
    #[serde(default)]
    pub attachment_convert_webp: bool,
}

impl Default for VaultConfig {
    fn default() -> Self {
        VaultConfig {
            name: "Untitled".into(),
            attachment_dir: "attachments".into(),
            line_ending: LineEnding::Lf,
            exclude_dirs: Vec::new(),
            show_hidden: false,
            encrypted: false,
            password_hash: None,
            salt: None,
            encrypt_mode: None,
            attachment_link_style: AttachmentLinkStyle::Wikilink,
            attachment_subfolder: true,
            attachment_name_style: AttachmentNameStyle::Timestamp,
            image_render_mode: ImageRenderMode::Data,
            attachment_link_format: AttachmentLinkFormat::Absolute,
            attachment_convert_webp: false,
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
        assert_eq!(cfg.attachment_dir, "attachments");
        assert_eq!(cfg.line_ending, LineEnding::Lf);
        assert!(cfg.exclude_dirs.is_empty());
        assert!(!cfg.show_hidden);
        assert_eq!(cfg.attachment_link_style, AttachmentLinkStyle::Wikilink);
        assert!(cfg.attachment_subfolder);
        assert_eq!(cfg.attachment_name_style, AttachmentNameStyle::Timestamp);
        assert_eq!(cfg.image_render_mode, ImageRenderMode::Data);
        assert_eq!(cfg.attachment_link_format, AttachmentLinkFormat::Absolute);
        assert!(!cfg.attachment_convert_webp);
    }

    #[test]
    fn test_config_missing_image_fields_uses_defaults() {
        // Backward compat: old config.json without the new fields must still parse.
        let json = r#"{"name":"V","attachment_dir":"attachments","line_ending":"lf"}"#;
        let cfg: VaultConfig = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.attachment_link_style, AttachmentLinkStyle::Wikilink);
        assert!(cfg.attachment_subfolder);
        assert_eq!(cfg.attachment_name_style, AttachmentNameStyle::Timestamp);
        assert_eq!(cfg.image_render_mode, ImageRenderMode::Data);
        assert_eq!(cfg.attachment_link_format, AttachmentLinkFormat::Absolute);
        assert!(!cfg.attachment_convert_webp);
    }

    #[test]
    fn test_image_field_serde_roundtrip() {
        // 枚举用 snake_case 序列化，前端以字符串读写
        let mut cfg = VaultConfig::default();
        cfg.attachment_link_style = AttachmentLinkStyle::Markdown;
        cfg.attachment_link_format = AttachmentLinkFormat::Shortest;
        cfg.attachment_name_style = AttachmentNameStyle::Sequence;
        cfg.image_render_mode = ImageRenderMode::Asset;
        cfg.attachment_convert_webp = true;
        let json = serde_json::to_string(&cfg).unwrap();
        assert!(json.contains("\"attachment_link_style\":\"markdown\""), "{}", json);
        assert!(json.contains("\"attachment_link_format\":\"shortest\""), "{}", json);
        assert!(json.contains("\"attachment_name_style\":\"sequence\""), "{}", json);
        assert!(json.contains("\"image_render_mode\":\"asset\""), "{}", json);
        let back: VaultConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back, cfg);
    }
}
