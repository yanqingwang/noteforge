use crate::error::SyncError;
use crate::file_api::{FileApi, FileEntry};
use async_trait::async_trait;
use reqwest::Client;
use serde::Deserialize;
use std::collections::HashMap;

// ── Joplin Server Data Models ───────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct JoplinItem {
    pub id: String,
    #[serde(default)]
    pub parent_id: String,
    pub title: String,
    #[serde(default)]
    pub body: String,
    pub type_: i32,
    #[serde(default)]
    pub encryption_applied: i32,
    #[serde(default)]
    pub encryption_cipher_text: String,
    #[serde(rename = "created_time", default)]
    pub created_time: i64,
    #[serde(rename = "updated_time", default)]
    pub updated_time: i64,
    #[serde(default)]
    pub is_deleted: bool,
    // Resource fields
    #[serde(default)]
    pub mime: String,
    #[serde(default)]
    pub filename: String,
    #[serde(rename = "file_extension", default)]
    pub file_extension: String,
    #[serde(default)]
    pub size: i64,
    // Note-Tag fields
    #[serde(default)]
    pub note_id: String,
    #[serde(default)]
    pub tag_id: String,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Deserialize)]
pub struct DeltaResponse {
    pub items: Vec<DeltaItem>,
    pub cursor: String,
    #[serde(default)]
    pub has_more: bool,
}

#[derive(Debug, Deserialize)]
pub struct DeltaItem {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(rename = "type")]
    pub event_type: i32,
    pub item: Option<JoplinItem>,
}

#[derive(Debug, Deserialize)]
struct ChildrenResponse {
    pub items: Vec<ChildrenItem>,
    #[serde(default)]
    pub has_more: bool,
}

#[derive(Debug, Deserialize)]
pub struct ChildrenItem {
    pub id: String,
    pub name: String,
    #[serde(rename = "updated_time")]
    pub updated_time: i64,
}

// ── Driver ──────────────────────────────────────────────────────────

pub struct JoplinServerDriver {
    client: Client,
    base_url: String,
    token: Option<String>,
}

impl JoplinServerDriver {
    pub fn new(base_url: &str) -> Result<Self, SyncError> {
        Ok(JoplinServerDriver {
            // Force HTTP/1.1: this Joplin Server deployment's body parser
            // (busboy) mishandles octet-stream PUT bodies over HTTP/2,
            // returning 500 "Missing required property: type_".
            client: Client::builder()
                .danger_accept_invalid_certs(true)
                .http1_only()
                .build()?,
            base_url: base_url.trim_end_matches('/').to_string(),
            token: None,
        })
    }

    /// Login to Joplin Server and get a session token.
    /// Retries on rate-limit errors with backoff.
    pub async fn login(&mut self, email: &str, password: &str) -> Result<(), SyncError> {
        let max_retries: u32 = 3;
        let mut attempt: u32 = 0;

        loop {
            attempt += 1;
            let url = format!("{}/api/sessions", self.base_url);
            let resp = self.client.post(&url)
                .header("Content-Type", "application/json")
                .json(&serde_json::json!({"email": email, "password": password}))
                .send().await?;

            let status = resp.status();
            let raw = resp.text().await?;

            eprintln!("[joplin] login attempt {}/{} status={} body={}",
                attempt, max_retries, status, &raw[..300.min(raw.len())]);

            // Check for rate-limit or server errors first
            if let Ok(data) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let Some(err_msg) = data["error"].as_str() {
                    let err = err_msg.to_lowercase();

                    // Rate limiting — extract wait time and retry
                    if err.contains("too many") && err.contains("login") {
                        if attempt < max_retries {
                            let wait = parse_wait_seconds(&err);
                            eprintln!("[joplin] rate-limited, waiting {}s before retry", wait);
                            tokio::time::sleep(std::time::Duration::from_secs(wait)).await;
                            continue;
                        }
                        return Err(SyncError::AuthFailed(format!(
                            "Login rate-limited after {} attempts: {}", attempt, err_msg
                        )));
                    }

                    // Other server errors
                    if err.contains("invalid") || err.contains("unauthorized")
                        || err.contains("forbidden") || err.contains("credentials")
                        || err.contains("password")
                    {
                        return Err(SyncError::AuthFailed(err_msg.to_string()));
                    }
                }
            }

            // Parse token from response
            if let Ok(data) = serde_json::from_str::<serde_json::Value>(&raw) {
                // Format 1: { "session": { "auth_token": "..." } }
                if let Some(token) = data["session"]["auth_token"].as_str() {
                    self.token = Some(token.to_string());
                    eprintln!("[joplin] login ok (session.auth_token)");
                    return Ok(());
                }
                // Format 2: { "auth_token": "..." }
                if let Some(token) = data["auth_token"].as_str() {
                    self.token = Some(token.to_string());
                    eprintln!("[joplin] login ok (auth_token)");
                    return Ok(());
                }
                // Format 3: { "token": "..." }
                if let Some(token) = data["token"].as_str() {
                    self.token = Some(token.to_string());
                    eprintln!("[joplin] login ok (token)");
                    return Ok(());
                }
                // Format 4: { "access_token": "..." }
                if let Some(token) = data["access_token"].as_str() {
                    self.token = Some(token.to_string());
                    eprintln!("[joplin] login ok (access_token)");
                    return Ok(());
                }
                // Format 5: { "id": "..." } — use session id
                if let Some(id) = data["id"].as_str() {
                    self.token = Some(id.to_string());
                    eprintln!("[joplin] login ok (session id)");
                    return Ok(());
                }
                // Format 6: { "session": { "id": "..." } }
                if let Some(id) = data["session"]["id"].as_str() {
                    self.token = Some(id.to_string());
                    eprintln!("[joplin] login ok (session id nested)");
                    return Ok(());
                }
            }

            if attempt < max_retries {
                eprintln!("[joplin] unknown response format, retrying...");
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                continue;
            }

            return Err(SyncError::AuthFailed(format!(
                "Unexpected login response: {}",
                &raw[..200.min(raw.len())]
            )));
        }
    }

    fn auth_headers(&self) -> Vec<(&str, String)> {
        let mut h = vec![
            ("X-API-MIN-VERSION", "2.6.0".into()),
        ];
        if let Some(ref t) = self.token {
            eprintln!("[joplin] auth header: X-API-AUTH={}", &t[..8.min(t.len())]);
            h.push(("X-API-AUTH", t.clone()));
        } else {
            eprintln!("[joplin] WARNING: no auth token set");
        }
        h
    }

    // ── Joplin Server Item API ──────────────────────────────────────

    /// Get item content (text body) by name.
    pub async fn get_item(&self, name: &str) -> Result<Vec<u8>, SyncError> {
        let url = format!("{}/api/items/root:/{}:/content", self.base_url, name);
        eprintln!("[joplin] GET {}", url);
        let mut req = self.client.get(&url);
        for (k, v) in self.auth_headers() { req = req.header(k, v); }
        let resp = req.send().await?;
        let status = resp.status();
        if status.is_success() {
            let data = resp.bytes().await?.to_vec();
            eprintln!("[joplin] GET {} ({} bytes)", status, data.len());
            Ok(data)
        } else if status.as_u16() == 404 {
            eprintln!("[joplin] GET 404");
            Err(SyncError::NotFound(name.to_string()))
        } else {
            eprintln!("[joplin] GET FAIL {}", status);
            Err(SyncError::Other(format!("get_item {}: {}", name, status)))
        }
    }

    /// Put item content. force=true overwrites existing items.
    ///
    /// Returns the server-assigned item id. NOTE: this Joplin Server deployment
    /// (non-standard) only stores raw content when the item name is NOT a bare
    /// 32-hex Joplin id, so callers should use a prefixed name (e.g. `nf-<hex>.md`)
    /// and send the body as `application/octet-stream`. Deletion must be done by
    /// the server-assigned id via `delete_item`, not by name.
    pub async fn put_item(&self, name: &str, data: &[u8], force: bool) -> Result<String, SyncError> {
        let url = format!("{}/api/items/root:/{}:/content?force={}", self.base_url, name, if force { 1 } else { 0 });
        eprintln!("[joplin] PUT {} ({} bytes)", url, data.len());
        let mut req = self.client.put(&url)
            .header("Content-Type", "application/octet-stream")
            .body(data.to_vec());
        for (k, v) in self.auth_headers() { req = req.header(k, v); }
        let resp = req.send().await?;
        let status = resp.status();
        if status.is_success() || status.as_u16() == 204 {
            let body = resp.text().await.unwrap_or_default();
            let id = serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|v| v["id"].as_str().map(|s| s.to_string()))
                .unwrap_or_default();
            eprintln!("[joplin] PUT {} id={}", status, id);
            Ok(id)
        } else {
            let body = resp.text().await.unwrap_or_default();
            eprintln!("[joplin] PUT FAIL {}: {}", status, &body[..200.min(body.len())]);
            Err(SyncError::Other(format!("put_item {}: {} {}", name, status, &body[..100.min(body.len())])))
        }
    }

    /// Delete an item by its server-assigned id (NOT by name).
    pub async fn delete_item(&self, id: &str) -> Result<(), SyncError> {
        let url = format!("{}/api/items/{}", self.base_url, id);
        let mut req = self.client.delete(&url);
        for (k, v) in self.auth_headers() { req = req.header(k, v); }
        let resp = req.send().await?;
        if resp.status().is_success() || resp.status().as_u16() == 404 {
            Ok(())
        } else {
            Err(SyncError::Other(format!("delete_item {}: {}", id, resp.status())))
        }
    }

    /// List all child items of the root. Returns paginated results.
    pub async fn list_all_children(&self) -> Result<Vec<ChildrenItem>, SyncError> {
        let mut all = Vec::new();
        let mut page: usize = 1;
        loop {
            let url = format!("{}/api/items/root:/:/children?page={}", self.base_url, page);
            eprintln!("[joplin] LIST children page={}", page);
            let mut req = self.client.get(&url);
            for (k, v) in self.auth_headers() { req = req.header(k, v); }
            let resp = req.send().await?;
            let status = resp.status();
            if !status.is_success() {
                let body = resp.text().await.unwrap_or_default();
                eprintln!("[joplin] LIST FAIL {}: {}", status, &body[..200.min(body.len())]);
                return Err(SyncError::Other(format!("list_children: {} {}", status, body)));
            }
            let raw = resp.text().await?;
            eprintln!("[joplin] LIST response ({} bytes)", raw.len());
            let data: ChildrenResponse = serde_json::from_str(&raw)
                .map_err(|e| SyncError::Other(format!("list_children parse: {} body={}", e, &raw[..200.min(raw.len())])))?;
            all.extend(data.items);
            if !data.has_more { break; }
            page += 1;
        }
        eprintln!("[joplin] LIST total: {} items", all.len());
        Ok(all)
    }

    /// List children of a specific folder item.
    pub async fn list_children_of(&self, parent_id: &str) -> Result<Vec<ChildrenItem>, SyncError> {
        let url = format!("{}/api/items/root:/{}:/children", self.base_url, parent_id);
        let mut req = self.client.get(&url);
        for (k, v) in self.auth_headers() { req = req.header(k, v); }
        let resp = req.send().await?;
        if !resp.status().is_success() {
            return Err(SyncError::Other(format!("list_children_of: {}", resp.status())));
        }
        let data: ChildrenResponse = resp.json().await?;
        Ok(data.items)
    }

    /// Get delta changes since cursor.
    pub async fn get_delta(&self, cursor: &str) -> Result<DeltaResponse, SyncError> {
        let url = format!("{}/api/items/root:/:/delta?cursor={}", self.base_url, cursor);
        let mut req = self.client.get(&url);
        for (k, v) in self.auth_headers() { req = req.header(k, v); }
        let resp = req.send().await?;
        if !resp.status().is_success() {
            return Err(SyncError::Other(format!("delta: {}", resp.status())));
        }
        Ok(resp.json().await?)
    }

    /// Consume all delta items to advance cursor.
    pub async fn consume_delta(&self) -> Result<String, SyncError> {
        let mut cursor = String::new();
        loop {
            let d = self.get_delta(&cursor).await?;
            cursor = d.cursor;
            if !d.has_more { break; }
        }
        Ok(cursor)
    }
}

// ── FileApi Implementation ──────────────────────────────────────────

/// Extract wait seconds from a rate-limit error message.
fn parse_wait_seconds(err: &str) -> u64 {
    // Try "try again in N seconds"
    for word in err.split_whitespace() {
        if let Ok(n) = word.trim_end_matches('.').parse::<u64>() {
            if n > 0 && n <= 300 { return n; }
        }
    }
    30 // Default wait
}

#[async_trait]
impl FileApi for JoplinServerDriver {
    async fn create(&self, path: &str, data: &[u8]) -> Result<(), SyncError> {
        let _ = self.put_item(path, data, false).await?;
        Ok(())
    }

    async fn put(&self, path: &str, data: &[u8]) -> Result<(), SyncError> {
        let _ = self.put_item(path, data, true).await?;
        Ok(())
    }

    async fn get(&self, path: &str) -> Result<Vec<u8>, SyncError> {
        self.get_item(path).await
    }

    async fn delete(&self, path: &str) -> Result<(), SyncError> {
        self.delete_item(path).await
    }

    async fn list(&self, _prefix: &str) -> Result<Vec<FileEntry>, SyncError> {
        let children = self.list_all_children().await?;
        Ok(children.into_iter().map(|c| FileEntry {
            path: c.name,
            is_dir: false,
            size: 0,
            updated_time: c.updated_time,
        }).collect())
    }

    async fn test(&self) -> Result<(), SyncError> {
        let url = format!("{}/api/ping", self.base_url);
        let mut req = self.client.get(&url);
        for (k, v) in self.auth_headers() { req = req.header(k, v); }
        let resp = req.send().await?;
        if resp.status().is_success() { Ok(()) }
        else { Err(SyncError::AuthFailed(format!("Ping failed: {}", resp.status()))) }
    }
}
