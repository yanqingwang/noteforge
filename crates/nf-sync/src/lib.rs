//! nf-sync — Nextcloud (WebDAV) vault mirror sync engine.
//!
//! Syncs a local vault directory 1:1 with a remote WebDAV tree
//! (Nextcloud `remote.php/dav`). Files are mirrored as-is at their
//! relative paths; content can optionally be AES-256-GCM encrypted
//! before upload (server stores ciphertext only).
//!
//! Core algorithm: snapshot local + remote listing → four-quadrant diff
//! against the last-sync state → action plan → apply → report.

pub mod error;
pub mod file_api;
pub mod crypto_layer;
pub mod drivers;
pub mod mirror;

pub use error::SyncError;
pub use file_api::{FileApi, FileEntry};
pub use crypto_layer::SyncCrypto;
pub use mirror::MirrorEngine;
pub use mirror::diff::{Action, Direction, SyncPlan};
pub use mirror::ignore::IgnoreRules;
pub use mirror::report::{SyncReport, ReportItem};
pub use mirror::state::{SyncState, StateEntry};
