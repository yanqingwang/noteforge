use crate::error::SyncError;
use crate::file_api::{FileApi, FileEntry};
use async_trait::async_trait;
use reqwest::{Client, Method};
use url::Url;

fn propfind_method() -> Method {
    Method::from_bytes(b"PROPFIND").unwrap()
}

pub struct WebDavDriver {
    client: Client,
    base_url: Url,
    username: String,
    password: String,
}

impl WebDavDriver {
    pub fn new(base_url: &str, username: &str, password: &str) -> Result<Self, SyncError> {
        let client = Client::builder()
            .danger_accept_invalid_certs(true)
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
}

#[async_trait]
impl FileApi for WebDavDriver {
    async fn create(&self, path: &str, data: &[u8]) -> Result<(), SyncError> {
        if self.exists(path).await? {
            return Err(SyncError::Other(format!("File exists: {}", path)));
        }
        self.put(path, data).await
    }

    async fn put(&self, path: &str, data: &[u8]) -> Result<(), SyncError> {
        let url = self.url_for(path);
        let resp = self.client.put(url)
            .body(data.to_vec())
            .basic_auth(&self.username, Some(&self.password))
            .send().await?;
        if resp.status().is_success() || resp.status().as_u16() == 204 {
            Ok(())
        } else {
            Err(SyncError::Other(format!("PUT failed: {} {}", resp.status(), path)))
        }
    }

    async fn get(&self, path: &str) -> Result<Vec<u8>, SyncError> {
        let url = self.url_for(path);
        let resp = self.client.get(url)
            .basic_auth(&self.username, Some(&self.password))
            .send().await?;
        if resp.status().is_success() {
            Ok(resp.bytes().await?.to_vec())
        } else if resp.status().as_u16() == 404 {
            Err(SyncError::NotFound(path.to_string()))
        } else {
            Err(SyncError::Other(format!("GET failed: {} {}", resp.status(), path)))
        }
    }

    async fn delete(&self, path: &str) -> Result<(), SyncError> {
        let url = self.url_for(path);
        let resp = self.client.delete(url)
            .basic_auth(&self.username, Some(&self.password))
            .send().await?;
        if resp.status().is_success() || resp.status().as_u16() == 404 {
            Ok(())
        } else {
            Err(SyncError::Other(format!("DELETE failed: {} {}", resp.status(), path)))
        }
    }

    async fn list(&self, prefix: &str) -> Result<Vec<FileEntry>, SyncError> {
        let url = self.url_for(prefix);
        let body = r#"<?xml version="1.0"?>
<d:propfind xmlns:d="DAV:"><d:prop>
<d:resourcetype/><d:getcontentlength/><d:getlastmodified/>
</d:prop></d:propfind>"#;
        let resp = self.client.request(propfind_method(), url)
            .body(body)
            .header("Depth", "1")
            .header("Content-Type", "application/xml")
            .basic_auth(&self.username, Some(&self.password))
            .send().await?;
        let text = resp.text().await?;
        let mut entries = Vec::new();
        for chunk in text.split("<d:response>").skip(1) {
            let href = match chunk.split("<d:href>").nth(1) {
                Some(s) => s.split("</d:href>").next().unwrap_or("").to_string(),
                None => continue,
            };
            let base_path = prefix.trim_end_matches('/');
            if href.is_empty() || href.trim_end_matches('/') == base_path {
                continue;
            }
            let is_dir = chunk.contains("<d:collection/>");
            let size = chunk.split("<d:getcontentlength>").nth(1)
                .and_then(|s| s.split("</d:getcontentlength>").next())
                .and_then(|s| s.trim().parse::<u64>().ok())
                .unwrap_or(0);
            entries.push(FileEntry { path: href, is_dir, size, updated_time: 0 });
        }
        Ok(entries)
    }

    async fn test(&self) -> Result<(), SyncError> {
        let url = self.url_for("");
        let resp = self.client.request(propfind_method(), url)
            .header("Depth", "0")
            .basic_auth(&self.username, Some(&self.password))
            .send().await?;
        if resp.status().is_success() || resp.status().as_u16() == 207 {
            Ok(())
        } else {
            Err(SyncError::AuthFailed(format!("WebDAV auth failed: {}", resp.status())))
        }
    }
}
