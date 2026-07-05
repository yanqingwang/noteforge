use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

/// Plugin manifest (plugin.toml).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginManifest {
    pub plugin: PluginMeta,
    pub permissions: PluginPermissions,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginMeta {
    pub id: String,
    pub name: String,
    pub version: String,
    pub api_version: String,
    pub min_app_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginPermissions {
    #[serde(default)]
    pub vault_read: bool,
    #[serde(default)]
    pub vault_write: bool,
    #[serde(default)]
    pub clipboard: bool,
    #[serde(default)]
    pub network: Vec<String>,
    #[serde(default)]
    pub shell: bool,
}

/// A loaded plugin.
pub struct Plugin {
    pub manifest: PluginManifest,
    pub wasm_bytes: Vec<u8>,
    pub dir: PathBuf,
}

impl Plugin {
    /// Load a plugin from a directory containing plugin.toml + main.wasm.
    pub fn load(path: &Path) -> Result<Self, PluginError> {
        let manifest_path = path.join("plugin.toml");
        if !manifest_path.exists() {
            return Err(PluginError::MissingManifest(path.to_path_buf()));
        }
        let manifest_str = fs::read_to_string(&manifest_path)?;
        let manifest: PluginManifest = toml::from_str(&manifest_str)?;

        let wasm_path = path.join("main.wasm");
        let wasm_bytes = if wasm_path.exists() {
            fs::read(&wasm_path)?
        } else {
            Vec::new() // empty WASM for manifest-only plugins
        };

        Ok(Plugin { manifest, wasm_bytes, dir: path.to_path_buf() })
    }

    /// Check permission.
    pub fn check_permission(&self, action: &str) -> bool {
        match action {
            "vault_read" => self.manifest.permissions.vault_read,
            "vault_write" => self.manifest.permissions.vault_write,
            "clipboard" => self.manifest.permissions.clipboard,
            "shell" => self.manifest.permissions.shell,
            _ => false,
        }
    }

    /// Create a WASM engine (requires main.wasm).
    pub fn create_engine(&self) -> Result<Option<wasmtime::Engine>, PluginError> {
        if self.wasm_bytes.is_empty() {
            return Ok(None);
        }
        let mut config = wasmtime::Config::new();
        config.wasm_multi_value(true);
        config.max_wasm_stack(256 * 1024);
        let engine = wasmtime::Engine::new(&config)?;
        Ok(Some(engine))
    }
}

// ── Plugin registry ──────────────────────────────────────────────────

pub struct PluginRegistry {
    plugins: HashMap<String, Plugin>,
}

impl PluginRegistry {
    pub fn new() -> Self { PluginRegistry { plugins: HashMap::new() } }

    pub fn register(&mut self, plugin: Plugin) {
        self.plugins.insert(plugin.manifest.plugin.id.clone(), plugin);
    }

    pub fn get(&self, id: &str) -> Option<&Plugin> { self.plugins.get(id) }
    pub fn all(&self) -> impl Iterator<Item = &Plugin> { self.plugins.values() }
    pub fn len(&self) -> usize { self.plugins.len() }
    pub fn is_empty(&self) -> bool { self.plugins.is_empty() }

    /// Scan a directory for plugins (each subdirectory with plugin.toml).
    pub fn scan_dir(&mut self, dir: &Path) -> Result<usize, PluginError> {
        if !dir.exists() { return Ok(0); }
        let mut count = 0;
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.is_dir() && path.join("plugin.toml").exists() {
                match Plugin::load(&path) {
                    Ok(plugin) => { self.register(plugin); count += 1; }
                    Err(e) => eprintln!("skipping plugin {:?}: {}", path, e),
                }
            }
        }
        Ok(count)
    }

    /// Load the built-in word-count plugin (manifest/data only).
    pub fn load_builtin_word_count(&mut self) {
        let manifest = word_count_manifest();
        let plugin = Plugin {
            manifest,
            wasm_bytes: vec![],
            dir: PathBuf::from("builtin"),
        };
        self.register(plugin);
    }
}

impl Default for PluginRegistry { fn default() -> Self { Self::new() } }

// ── Built-in utilities ──────────────────────────────────────────────

pub fn word_count_manifest() -> PluginManifest {
    PluginManifest {
        plugin: PluginMeta {
            id: "nf.word-count".into(), name: "Word Count".into(),
            version: "1.0.0".into(), api_version: "1.0".into(),
            min_app_version: Some("0.1.0".into()),
        },
        permissions: PluginPermissions {
            vault_read: true, vault_write: false,
            clipboard: false, network: vec![], shell: false,
        },
    }
}

pub fn count_words(text: &str) -> (usize, usize, usize) {
    (text.chars().count(), text.split_whitespace().count(), text.lines().count())
}

pub fn reading_time(text: &str) -> f64 {
    text.split_whitespace().count() as f64 / 200.0
}

/// Generate a plugin.toml for a new plugin.
pub fn generate_manifest(id: &str, name: &str) -> String {
    format!(r#"[plugin]
id = "{}"
name = "{}"
version = "1.0.0"
api_version = "1.0"
min_app_version = "0.1.0"

[permissions]
vault_read = true
vault_write = false
clipboard = false
network = []
shell = false
"#, id, name)
}

// ── Errors ───────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum PluginError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("toml: {0}")]
    Toml(#[from] toml::de::Error),
    #[error("missing manifest: {0}")]
    MissingManifest(PathBuf),
    #[error("wasmtime: {0}")]
    Wasmtime(#[from] wasmtime::Error),
}

// ── Tests ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn test_manifest_parse() {
        let toml = r#"
[plugin]
id = "com.example.test"
name = "Test"
version = "1.0.0"
api_version = "1.0"

[permissions]
vault_read = true
"#;
        let m: PluginManifest = toml::from_str(toml).unwrap();
        assert_eq!(m.plugin.id, "com.example.test");
        assert!(m.permissions.vault_read);
        assert!(!m.permissions.vault_write);
    }

    #[test]
    fn test_word_count() {
        let (c, w, l) = count_words("hello world\nfoo bar baz");
        assert_eq!(c, 23);
        assert_eq!(w, 5);
        assert_eq!(l, 2);
    }

    #[test]
    fn test_reading_time() {
        let t = "word ".repeat(200);
        let rt = reading_time(t.trim_end());
        assert!((rt - 1.0).abs() < 0.1);
    }

    #[test]
    fn test_permission_check() {
        let p = Plugin { manifest: word_count_manifest(), wasm_bytes: vec![], dir: PathBuf::from(".") };
        assert!(p.check_permission("vault_read"));
        assert!(!p.check_permission("vault_write"));
    }

    #[test]
    fn test_registry() {
        let mut reg = PluginRegistry::new();
        reg.load_builtin_word_count();
        assert_eq!(reg.len(), 1);
        assert!(reg.get("nf.word-count").is_some());
    }

    #[test]
    fn test_scan_directory() {
        let dir = tempfile::tempdir().unwrap();
        let plugin_dir = dir.path().join("my-plugin");
        fs::create_dir(&plugin_dir).unwrap();
        fs::write(plugin_dir.join("plugin.toml"), r#"
[plugin]
id = "test.scan"
name = "Scan Test"
version = "1.0.0"
api_version = "1.0"

[permissions]
vault_read = true
"#).unwrap();

        let mut reg = PluginRegistry::new();
        reg.scan_dir(dir.path()).unwrap();
        assert_eq!(reg.len(), 1);
    }

    #[test]
    fn test_generate_manifest() {
        let s = generate_manifest("custom.test", "My Plugin");
        assert!(s.contains("custom.test"));
        assert!(s.contains("My Plugin"));
    }

    #[test]
    fn test_empty_registry() {
        let reg = PluginRegistry::new();
        assert!(reg.is_empty());
    }
}
