//! WebDAV driver targeting Nextcloud (`remote.php/dav`).
//!
//! - `list` walks the tree with recursive Depth:1 PROPFIND requests
//!   (Depth: infinity is disabled on many Nextcloud instances).
//! - `put` returns the server etag so the next diff can skip the file.
//! - `delete` relies on Nextcloud's server-side trashbin.
//! - `test` classifies 401 / 404 / timeout into readable errors.

use crate::error::SyncError;
use crate::file_api::{FileApi, FileEntry};
use async_trait::async_trait;
use percent_encoding::percent_decode_str;
use reqwest::{Client, Method, StatusCode};
use url::Url;

fn propfind() -> Method {
    Method::from_bytes(b"PROPFIND").unwrap()
}

fn mkcol() -> Method {
    Method::from_bytes(b"MKCOL").unwrap()
}

pub struct WebDavDriver {
    client: Client,
    base_url: Url,
    username: String,
    password: String,
}

/// Build the WebDAV files endpoint for a Nextcloud instance.
/// Accepts either a bare server URL (`https://nc.example.com`) or a full
/// DAV path (already contains `remote.php/dav`).
pub fn nextcloud_files_url(server_url: &str, username: &str, remote_root: &str) -> Result<String, SyncError> {
    let server = server_url.trim_end_matches('/');
    if server.contains("remote.php/dav") || server.contains("remote.php/webdav") {
        return Ok(format!("{}/", server.trim_end_matches('/')));
    }
    let root = remote_root.trim_matches('/');
    if root.is_empty() {
        Ok(format!("{}/remote.php/dav/files/{}/", server, username))
    } else {
        Ok(format!("{}/remote.php/dav/files/{}/{}/", server, username, root))
    }
}

impl WebDavDriver {
    pub fn new(base_url: &str, username: &str, password: &str) -> Result<Self, SyncError> {
        let client = Client::builder()
            .danger_accept_invalid_certs(true)
            .timeout(std::time::Duration::from_secs(120))
            .connect_timeout(std::time::Duration::from_secs(20))
            .user_agent("NoteForge-Sync/0.2")
            .build()?;
        Ok(WebDavDriver {
            client,
            base_url: Url::parse(base_url)?,
            username: username.to_string(),
            password: password.to_string(),
        })
    }

    fn url_for(&self, path: &str) -> Url {
        let clean = path.trim_start_matches('/');
        self.base_url.join(clean).unwrap_or_else(|_| self.base_url.clone())
    }

    /// Rel path of a PROPFIND href relative to the sync root.
    fn rel_from_href(&self, href: &str) -> Option<String> {
        let href_path = Url::parse(&format!("https://x.test{}", href))
            .ok()
            .map(|u| u.path().to_string())
            .unwrap_or_else(|| href.to_string());
        let base_path = self.base_url.path(); // always ends with '/'
        let rel = if let Some(stripped) = href_path.strip_prefix(&base_path[..base_path.len() - 1]) {
            stripped
        } else {
            return None;
        };
        let decoded = percent_decode_str(rel).decode_utf8().ok()?;
        let decoded = decoded.trim_matches('/').to_string();
        if decoded.is_empty() {
            None
        } else {
            Some(decoded)
        }
    }

    async fn propfind_dir(&self, path: &str) -> Result<Vec<FileEntry>, SyncError> {
        let url = self.url_for(path);
        let body = r#"<?xml version="1.0"?>
<d:propfind xmlns:d="DAV:"><d:prop>
<d:resourcetype/><d:getcontentlength/><d:getlastmodified/><d:getetag/>
</d:prop></d:propfind>"#;
        let resp = self.client.request(propfind(), url)
            .body(body)
            .header("Depth", "1")
            .header("Content-Type", "application/xml")
            .basic_auth(&self.username, Some(&self.password))
            .send().await?;
        match resp.status() {
            s if s.is_success() || s.as_u16() == 207 => {}
            StatusCode::UNAUTHORIZED => return Err(SyncError::AuthFailed("用户名或应用密码错误 (401)".into())),
            StatusCode::NOT_FOUND => return Err(SyncError::NotFound(format!("远端目录不存在: {}", path))),
            s => return Err(SyncError::Other(format!("PROPFIND 失败: {} {}", s, path))),
        }
        let text = resp.text().await?;
        let mut entries = Vec::new();
        for chunk in split_responses(&text) {
            let href = match extract_tag(&chunk, "href") {
                Some(h) => h,
                None => continue,
            };
            let rel = match self.rel_from_href(&href) {
                Some(r) => r,
                None => continue,
            };
            // Skip the directory itself when walking a subpath
            if path.trim_matches('/').is_empty() {
                if rel.is_empty() { continue; }
            } else if rel == path.trim_matches('/') {
                continue;
            }
            let is_dir = chunk.contains("collection");
            let size = extract_tag(&chunk, "getcontentlength")
                .and_then(|s| s.trim().parse::<u64>().ok())
                .unwrap_or(0);
            let updated_time = extract_tag(&chunk, "getlastmodified")
                .and_then(|s| chrono::DateTime::parse_from_rfc2822(&s).ok())
                .map(|d| d.timestamp_millis())
                .unwrap_or(0);
            let etag = extract_tag(&chunk, "getetag").map(|s| s.trim().trim_matches('"').to_string());
            entries.push(FileEntry { path: rel, is_dir, size, updated_time, etag });
        }
        Ok(entries)
    }

    /// Fetch a single file's etag via Depth:0 PROPFIND.
    async fn etag_of(&self, path: &str) -> Result<Option<String>, SyncError> {
        let url = self.url_for(path);
        let body = r#"<?xml version="1.0"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:getetag/></d:prop></d:propfind>"#;
        let resp = self.client.request(propfind(), url)
            .body(body)
            .header("Depth", "0")
            .basic_auth(&self.username, Some(&self.password))
            .send().await?;
        if !resp.status().is_success() && resp.status().as_u16() != 207 {
            return Ok(None);
        }
        let text = resp.text().await?;
        Ok(extract_tag(&text, "getetag").map(|s| s.trim().trim_matches('"').to_string()))
    }
}

/// Split a multistatus body into `<response>…</response>` chunks,
/// tolerating `d:`/`D:` namespace prefixes or none at all.
fn split_responses(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(start) = find_tag_start(rest, "response") {
        let after = &rest[start..];
        let end = find_tag_end(after, "response")
            .unwrap_or(after.len());
        out.push(after[..end].to_string());
        rest = &after[end..];
    }
    out
}

fn find_tag_start(text: &str, tag: &str) -> Option<usize> {
    [format!("<d:{}>", tag), format!("<D:{}>", tag), format!("<{}>", tag)]
        .iter()
        .filter_map(|open| text.find(open.as_str()))
        .min()
}

fn find_tag_end(text: &str, tag: &str) -> Option<usize> {
    [format!("</d:{}>", tag), format!("</D:{}>", tag), format!("</{}>", tag)]
        .iter()
        .filter_map(|close| text.find(close.as_str()).map(|i| i + close.len()))
        .min()
}

/// Extract the inner text of `<…tag>value</…tag>` (first occurrence,
/// any namespace prefix).
fn extract_tag(chunk: &str, tag: &str) -> Option<String> {
    let opens: [&str; 3] = [&format!("<d:{}>", tag), &format!("<D:{}>", tag), &format!("<{}>", tag)];
    let closes: [&str; 3] = [&format!("</d:{}>", tag), &format!("</D:{}>", tag), &format!("</{}>", tag)];
    for (open, close) in opens.iter().zip(closes.iter()) {
        let (open, close) = (*open, *close);
        if let Some(i) = chunk.find(open) {
            let after = &chunk[i + open.len()..];
            if let Some(j) = after.find(close) {                return Some(after[..j].trim().to_string());
            }
        }
    }
    None
}

#[async_trait]
impl FileApi for WebDavDriver {
    async fn put(&self, path: &str, data: &[u8]) -> Result<Option<String>, SyncError> {
        // Ensure parent directories exist (MKCOL parents first)
        let parent = std::path::Path::new(path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        if !parent.is_empty() && parent != "/" {
            self.mkdir(&parent).await?;
        }
        let url = self.url_for(path);
        let resp = self.client.put(url)
            .body(data.to_vec())
            .header("Content-Type", "application/octet-stream")
            .basic_auth(&self.username, Some(&self.password))
            .send().await?;
        match resp.status() {
            s if s.is_success() => {
                let etag = resp
                    .headers()
                    .get("etag")
                    .and_then(|v| v.to_str().ok())
                    .map(|s| s.trim().trim_matches('"').to_string());
                match etag {
                    Some(e) => Ok(Some(e)),
                    None => self.etag_of(path).await, // some servers omit the header
                }
            }
            StatusCode::UNAUTHORIZED => Err(SyncError::AuthFailed("上传被拒绝: 用户名或应用密码错误 (401)".into())),
            StatusCode::INSUFFICIENT_STORAGE => Err(SyncError::Other("服务器存储空间不足 (507)".into())),
            s => Err(SyncError::Other(format!("PUT 失败: {} {}", s, path))),
        }
    }

    async fn get(&self, path: &str) -> Result<Vec<u8>, SyncError> {
        let url = self.url_for(path);
        let resp = self.client.get(url)
            .basic_auth(&self.username, Some(&self.password))
            .send().await?;
        match resp.status() {
            s if s.is_success() => Ok(resp.bytes().await?.to_vec()),
            StatusCode::NOT_FOUND => Err(SyncError::NotFound(path.to_string())),
            StatusCode::UNAUTHORIZED => Err(SyncError::AuthFailed("下载被拒绝: 认证失败 (401)".into())),
            s => Err(SyncError::Other(format!("GET 失败: {} {}", s, path))),
        }
    }

    async fn delete(&self, path: &str) -> Result<(), SyncError> {
        let url = self.url_for(path);
        let resp = self.client.delete(url)
            .basic_auth(&self.username, Some(&self.password))
            .send().await?;
        match resp.status() {
            s if s.is_success() || s.as_u16() == 404 => Ok(()),
            StatusCode::UNAUTHORIZED => Err(SyncError::AuthFailed("删除被拒绝: 认证失败 (401)".into())),
            s => Err(SyncError::Other(format!("DELETE 失败: {} {}", s, path))),
        }
    }

    async fn mkdir(&self, path: &str) -> Result<(), SyncError> {
        // Create every missing ancestor (MKCOL requires an existing parent).
        let parts: Vec<&str> = path.trim_matches('/').split('/').filter(|s| !s.is_empty()).collect();
        let mut current = String::new();
        for part in parts {
            current = if current.is_empty() { part.to_string() } else { format!("{}/{}", current, part) };
            let url = self.url_for(&current);
            let resp = self.client.request(mkcol(), url)
                .basic_auth(&self.username, Some(&self.password))
                .send().await?;
            // 201 created, 405 already exists, 301 some proxies — all fine
            if !resp.status().is_success() && resp.status().as_u16() != 405 {
                return Err(SyncError::Other(format!("MKCOL 失败: {} {}", resp.status(), current)));
            }
        }
        Ok(())
    }

    async fn list(&self, prefix: &str) -> Result<Vec<FileEntry>, SyncError> {
        // Iterative BFS walk with Depth:1 (works on every Nextcloud config).
        let start = prefix.trim_matches('/').to_string();
        let mut out = Vec::new();
        let mut queue = std::collections::VecDeque::new();
        queue.push_back(start.clone());
        if !start.is_empty() {
            // Include the root entry itself only as a walk start, not in output
        }
        let mut visited = std::collections::HashSet::new();
        while let Some(dir) = queue.pop_front() {
            if !visited.insert(dir.clone()) {
                continue;
            }
            let children = self.propfind_dir(&dir).await?;
            for child in children {
                if child.is_dir {
                    queue.push_back(child.path.clone());
                } else {
                    out.push(child);
                }
            }
        }
        Ok(out)
    }

    async fn test(&self) -> Result<(), SyncError> {
        let url = self.base_url.clone();
        let resp = self.client.request(propfind(), url)
            .body("<d:propfind xmlns:d=\"DAV:\"><d:prop><d:resourcetype/></d:prop></d:propfind>")
            .header("Depth", "0")
            .basic_auth(&self.username, Some(&self.password))
            .send().await?;
        match resp.status() {
            StatusCode::UNAUTHORIZED => Err(SyncError::AuthFailed("认证失败: 请检查用户名与应用密码 (401)".into())),
            StatusCode::FORBIDDEN => Err(SyncError::AuthFailed("无权访问该目录 (403): 请检查应用密码权限与远程目录".into())),
            StatusCode::NOT_FOUND => Err(SyncError::NotFound(format!("远端目录不存在 (404): {}", self.base_url))),
            s if s.is_success() || s.as_u16() == 207 => Ok(()),
            s => Err(SyncError::Other(format!("连接失败: HTTP {}", s))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nextcloud_url_normalization() {
        let u = nextcloud_files_url("https://nc.example.com", "alice", "NoteForge").unwrap();
        assert_eq!(u, "https://nc.example.com/remote.php/dav/files/alice/NoteForge/");
        let u = nextcloud_files_url("https://nc.example.com/", "alice", "").unwrap();
        assert_eq!(u, "https://nc.example.com/remote.php/dav/files/alice/");
        let u = nextcloud_files_url("https://nc.example.com/remote.php/dav/files/alice/NoteForge/", "alice", "x").unwrap();
        assert_eq!(u, "https://nc.example.com/remote.php/dav/files/alice/NoteForge/");
    }

    #[test]
    fn parse_multistatus_d_prefix() {
        let xml = r#"<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns">
 <d:response>
  <d:href>/remote.php/dav/files/alice/NoteForge/</d:href>
  <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
 </d:response>
 <d:response>
  <d:href>/remote.php/dav/files/alice/NoteForge/%E7%AC%94%E8%AE%B0.md</d:href>
  <d:propstat><d:prop>
   <d:resourcetype/>
   <d:getcontentlength>2048</d:getcontentlength>
   <d:getetag>&quot;abc123&quot;</d:getetag>
   <d:getlastmodified>Sat, 12 Sep 2026 03:00:00 GMT</d:getlastmodified>
  </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
 </d:response>
</d:multistatus>"#;
        let chunks = split_responses(xml);
        assert_eq!(chunks.len(), 2);
        assert_eq!(extract_tag(&chunks[1], "getcontentlength").as_deref(), Some("2048"));
        assert_eq!(extract_tag(&chunks[1], "getetag").as_deref(), Some("&quot;abc123&quot;"));
        assert!(chunks[0].contains("collection"));
    }

    #[test]
    fn parse_multistatus_no_prefix() {
        let xml = "<multistatus><response><href>/dav/f/a.md</href><propstat><prop><getetag>\"1\"</getetag><getcontentlength>5</getcontentlength></prop></propstat></response></multistatus>";
        let chunks = split_responses(xml);
        assert_eq!(chunks.len(), 1);
        assert_eq!(extract_tag(&chunks[0], "getetag").as_deref(), Some("\"1\""));
    }

    #[test]
    fn rel_from_href_percent_decoded() {
        let d = WebDavDriver::new("https://nc.example.com/remote.php/dav/files/alice/NoteForge/", "a", "b").unwrap();
        assert_eq!(
            d.rel_from_href("/remote.php/dav/files/alice/NoteForge/%E7%AC%94%E8%AE%B0.md").as_deref(),
            Some("笔记.md")
        );
        assert_eq!(d.rel_from_href("/remote.php/dav/files/alice/NoteForge/").as_deref(), None);
        assert_eq!(d.rel_from_href("/remote.php/dav/files/alice/NoteForge/dir/sub/a.md").as_deref(), Some("dir/sub/a.md"));
    }
}
