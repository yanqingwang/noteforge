//! Sync report: per-action outcome plus aggregate counters.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SyncReport {
    pub started_at: i64,
    pub finished_at: i64,
    pub uploaded: usize,
    pub downloaded: usize,
    pub conflicts: usize,
    pub deleted_remote: usize,
    pub deleted_local: usize,
    pub skipped: usize,
    pub errors: usize,
    pub first_sync: bool,
    pub encrypted: bool,
    pub items: Vec<ReportItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReportItem {
    pub path: String,
    pub action: String,
    pub ok: bool,
    #[serde(default)]
    pub message: String,
}

impl SyncReport {
    pub fn new() -> Self {
        SyncReport {
            started_at: chrono::Utc::now().timestamp(),
            ..Default::default()
        }
    }

    pub fn push(&mut self, path: &str, action: &str, ok: bool, message: impl Into<String>) {
        let msg = message.into();
        if !ok {
            self.errors += 1;
        }
        match action {
            "upload" | "reupload" => self.uploaded += 1,
            "download" | "restore" => self.downloaded += 1,
            "conflict" => self.conflicts += 1,
            "delete-remote" => self.deleted_remote += 1,
            "delete-local" => self.deleted_local += 1,
            _ => self.skipped += 1,
        }
        self.items.push(ReportItem { path: path.to_string(), action: action.to_string(), ok, message: msg });
    }

    /// One-line human summary (used by the status bar / toast).
    pub fn summary(&self) -> String {
        if self.errors > 0 {
            format!(
                "⚠ 同步完成：上传 {} · 下载 {} · 冲突 {} · 删除 {} · 失败 {}",
                self.uploaded, self.downloaded, self.conflicts,
                self.deleted_remote + self.deleted_local, self.errors
            )
        } else {
            format!(
                "✅ 同步完成：上传 {} · 下载 {} · 冲突 {} · 删除 {}",
                self.uploaded, self.downloaded, self.conflicts,
                self.deleted_remote + self.deleted_local
            )
        }
    }
}
