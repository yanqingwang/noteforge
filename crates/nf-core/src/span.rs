use crate::error::Error;
use serde::{Deserialize, Serialize};

/// A half-open byte offset range `[start, end)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Span {
    pub start: usize,
    pub end: usize,
}

impl Span {
    pub fn new(start: usize, end: usize) -> Result<Self, Error> {
        if start > end {
            return Err(Error::InvalidSpan { start, end });
        }
        Ok(Self { start, end })
    }

    pub fn len(&self) -> usize {
        self.end - self.start
    }

    pub fn is_empty(&self) -> bool {
        self.start == self.end
    }

    pub fn contains(&self, byte_offset: usize) -> bool {
        byte_offset >= self.start && byte_offset < self.end
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_span_new_valid() {
        let s = Span::new(0, 10).unwrap();
        assert_eq!(s.start, 0);
        assert_eq!(s.end, 10);
        assert_eq!(s.len(), 10);
    }

    #[test]
    fn test_span_new_empty() {
        let s = Span::new(5, 5).unwrap();
        assert!(s.is_empty());
        assert_eq!(s.len(), 0);
    }

    #[test]
    fn test_span_new_invalid() {
        assert!(Span::new(10, 5).is_err());
    }

    #[test]
    fn test_span_contains() {
        let s = Span::new(3, 8).unwrap();
        assert!(!s.contains(2));
        assert!(s.contains(3));
        assert!(s.contains(7));
        assert!(!s.contains(8));
    }

    #[test]
    fn test_span_serde_roundtrip() {
        let s = Span::new(42, 100).unwrap();
        let json = serde_json::to_string(&s).unwrap();
        let back: Span = serde_json::from_str(&json).unwrap();
        assert_eq!(s, back);
    }
}
