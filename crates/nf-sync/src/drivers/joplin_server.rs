use crate::error::SyncError;
use crate::file_api::{FileApi, FileEntry};
use async_trait::async_trait;
use reqwest::Client;
use url::Url;

pub struct JoplinServerDriver {
    client: Client,
    base_url: Url,
    token: Option<String>,
}

impl JoplinServerDriver {
    pub fn new(base_url: &str) -> Result<Self, SyncError> {
        let client = Client::builder()
            .danger_accept_invalid_certs(true)
            .build()?;
        Ok(JoplinServerDriver {
            client,
            base_url: Url::parse(base_url)?,
            token: None,
        })
    }

    pub async fn login(&mut self, email: &str, password: &str) -> Result<(), SyncError> {
        let url = self.base_url.join("/api/session/login")?;
        let resp = self.client.post(url)
            .json(&serde_json::json!({"email": email, "password": password}))
            .send().await?;
        if !resp.status().is_success() {
            return Err(SyncError::AuthFailed(format!("Login failed: {}", resp.status())));
        }
        let data: serde_json::Value = resp.json().await?;
        self.token = data["token"].as_str().map(|s| s.to_string());
        if self.token.is_none() {
            // Try alternative response format
            self.token = data["access_token"].as_str().map(|s| s.to_string());
        }
        Ok(())
    }

    fn api_url(&self, path: &str) -> Result<Url, SyncError> {
        let clean = path.trim_start_matches('/');
        Ok(self.base_url.join(&format!("/api/{}", clean))?)
    }
}

#[async_trait]
impl FileApi for JoplinServerDriver {
    async fn create(&self, path: &str, data: &[u8]) -> Result<(), SyncError> {
        self.put(path, data).await
    }

    async fn put(&self, path: &str, data: &[u8]) -> Result<(), SyncError> {
        let url = self.api_url(&format!("files/{}", path))?;
        let mut req = self.client.put(url).body(data.to_vec());
        if let Some(token) = &self.token {
            req = req.bearer_auth(token);
        }
        let resp = req.send().await?;
        if resp.status().is_success() || resp.status().as_u16() == 204 {
            Ok(())
        } else {
            Err(SyncError::Other(format!("PUT failed: {} {}", resp.status(), path)))
        }
    }

    async fn get(&self, path: &str) -> Result<Vec<u8>, SyncError> {
        let url = self.api_url(&format!("files/{}", path))?;
        let mut req = self.client.get(url);
        if let Some(token) = &self.token {
            req = req.bearer_auth(token);
        }
        let resp = req.send().await?;
        if resp.status().is_success() {
            Ok(resp.bytes().await?.to_vec())
        } else if resp.status().as_u16() == 404 {
            Err(SyncError::NotFound(path.to_string()))
        } else {
            Err(SyncError::Other(format!("GET failed: {} {}", resp.status(), path)))
        }
    }

    async fn delete(&self, path: &str) -> Result<(), SyncError> {
        let url = self.api_url(&format!("files/{}", path))?;
        let mut req = self.client.delete(url);
        if let Some(token) = &self.token {
            req = req.bearer_auth(token);
        }
        let resp = req.send().await?;
        if resp.status().is_success() || resp.status().as_u16() == 404 {
            Ok(())
        } else {
            Err(SyncError::Other(format!("DELETE failed: {} {}", resp.status(), path)))
        }
    }

    async fn list(&self, prefix: &str) -> Result<Vec<FileEntry>, SyncError> {
        let url = self.api_url(&format!("files/delta?path={}", prefix))?;
        let mut req = self.client.get(url);
        if let Some(token) = &self.token {
            req = req.bearer_auth(token);
        }
        let resp = req.send().await?;
        let data: serde_json::Value = resp.json().await?;
        let mut entries = Vec::new();
        if let Some(items) = data["items"].as_array() {
            for item in items {
                if let Some(name) = item["name"].as_str() {
                    entries.push(FileEntry {
                        path: name.to_string(),
                        is_dir: item["is_dir"].as_bool().unwrap_or(false),
                        size: item["size"].as_u64().unwrap_or(0),
                        updated_time: item["updated_time"].as_i64().unwrap_or(0),
                    });
                }
            }
        }
        Ok(entries)
    }

    async fn test(&self) -> Result<(), SyncError> {
        let url = self.api_url("ping")?;
        let mut req = self.client.get(url);
        if let Some(token) = &self.token {
            req = req.bearer_auth(token);
        }
        let resp = req.send().await?;
        if resp.status().is_success() {
            Ok(())
        } else {
            Err(SyncError::AuthFailed(format!("Server ping failed: {}", resp.status())))
        }
    }
}
