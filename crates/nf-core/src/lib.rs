pub mod error;
pub mod link;
pub mod note;
pub mod span;
pub mod tag;
pub mod vault;

pub use error::Error;
pub use link::{Link, LinkKind};
pub use note::{BlockId, Frontmatter, Heading, NoteMeta};
pub use span::Span;
pub use tag::Tag;
pub use vault::{LineEnding, Vault, VaultConfig};
