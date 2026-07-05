use ropey::Rope;

/// Position in the buffer (line, column).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Position {
    pub line: usize,
    pub column: usize,
}

/// A single editing operation for undo/redo.
#[derive(Debug, Clone)]
pub struct Edit {
    pub kind: EditKind,
    pub cursor_before: Vec<Position>,
    pub cursor_after: Vec<Position>,
}

#[derive(Debug, Clone)]
pub enum EditKind {
    Insert { pos: usize, text: String },
    Delete { pos: usize, len: usize, text: String },
}

/// Rope-based text editor engine with multi-cursor and undo/redo.
pub struct Editor {
    rope: Rope,
    cursors: Vec<Position>,
    undo_stack: Vec<Edit>,
    redo_stack: Vec<Edit>,
    max_undo: usize,
}

impl Editor {
    pub fn new() -> Self {
        Editor {
            rope: Rope::new(),
            cursors: vec![Position { line: 0, column: 0 }],
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
            max_undo: 1000,
        }
    }

    pub fn from_text(text: &str) -> Self {
        let rope = Rope::from_str(text);
        let last_line = rope.len_lines().saturating_sub(1);
        let last_col = if last_line > 0 { rope.line(last_line - 1).len_chars() } else { rope.line(0).len_chars() };
        Editor {
            rope,
            cursors: vec![Position { line: last_line, column: last_col }],
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
            max_undo: 1000,
        }
    }

    pub fn text(&self) -> String {
        self.rope.to_string()
    }

    pub fn rope(&self) -> &Rope {
        &self.rope
    }

    pub fn char_count(&self) -> usize {
        self.rope.len_chars()
    }

    pub fn line_count(&self) -> usize {
        self.rope.len_lines()
    }

    pub fn line_text(&self, idx: usize) -> String {
        self.rope.line(idx).to_string()
    }

    pub fn cursors(&self) -> &[Position] {
        &self.cursors
    }

    pub fn set_cursors(&mut self, cursors: Vec<Position>) {
        self.cursors = cursors;
    }

    pub fn insert(&mut self, text: &str) {
        let before = self.cursors.clone();
        let pos = self.char_offset(self.cursors[0]);
        self.rope.insert(pos, text);
        let after = self.cursors.clone();
        self.push_undo(EditKind::Insert { pos, text: text.to_string() }, &before, &after);
    }

    pub fn delete_before(&mut self) {
        let before = self.cursors.clone();
        let pos = self.char_offset(self.cursors[0]);
        if pos > 0 && pos <= self.rope.len_chars() {
            let start = pos - 1;
            let removed = self.rope.slice(start..pos).to_string();
            self.rope.remove(start..pos);
            let after = self.cursors.clone();
            self.push_undo(EditKind::Delete { pos: start, len: 1, text: removed }, &before, &after);
            self.move_cursor_left(1);
        }
    }

    pub fn delete_after(&mut self) {
        let before = self.cursors.clone();
        let pos = self.char_offset(self.cursors[0]);
        if pos < self.rope.len_chars() {
            let end = pos + 1;
            let removed = self.rope.slice(pos..end).to_string();
            self.rope.remove(pos..end);
            let after = self.cursors.clone();
            self.push_undo(EditKind::Delete { pos, len: 1, text: removed }, &before, &after);
        }
    }

    pub fn undo(&mut self) {
        if let Some(edit) = self.undo_stack.pop() {
            self.redo_stack.push(edit.clone());
            match &edit.kind {
                EditKind::Insert { pos, text } => {
                    self.rope.remove(*pos..pos + text.len());
                }
                EditKind::Delete { pos, len: _, text } => {
                    self.rope.insert(*pos, text);
                }
            }
            self.cursors = edit.cursor_before;
        }
    }

    pub fn redo(&mut self) {
        if let Some(edit) = self.redo_stack.pop() {
            self.undo_stack.push(edit.clone());
            match &edit.kind {
                EditKind::Insert { pos, text } => {
                    self.rope.insert(*pos, text);
                }
                EditKind::Delete { pos, len, text: _ } => {
                    self.rope.remove(*pos..pos + len);
                }
            }
            self.cursors = edit.cursor_after;
        }
    }

    fn push_undo(&mut self, kind: EditKind, before: &[Position], after: &[Position]) {
        self.undo_stack.push(Edit {
            kind,
            cursor_before: before.to_vec(),
            cursor_after: after.to_vec(),
        });
        self.redo_stack.clear();
        if self.undo_stack.len() > self.max_undo {
            self.undo_stack.remove(0);
        }
    }

    fn char_offset(&self, pos: Position) -> usize {
        let mut offset = 0;
        for i in 0..pos.line.min(self.rope.len_lines()) {
            offset += self.rope.line(i).len_chars();
        }
        offset + pos.column.min(self.rope.line(pos.line.min(self.rope.len_lines() - 1)).len_chars())
    }

    fn move_cursor_left(&mut self, n: usize) {
        let pos = {
            let c = self.cursors.first().copied().unwrap_or(Position { line: 0, column: 0 });
            self.char_offset(c)
        };
        if pos >= n {
            let new_pos = pos - n;
            let mut chars = 0;
            for (i, line) in self.rope.lines().enumerate() {
                let lc = line.len_chars();
                if chars + lc > new_pos {
                    self.cursors = vec![Position { line: i, column: new_pos - chars }];
                    return;
                }
                chars += lc;
            }
        }
    }
}

impl Default for Editor {
    fn default() -> Self {
        Self::new()
    }
}

// ── Syntax highlighting (basic) ──────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenKind {
    Normal,
    Heading,
    Bold,
    Italic,
    Code,
    Link,
    List,
    Quote,
    Comment,
}

#[derive(Debug, Clone)]
pub struct Token {
    pub kind: TokenKind,
    pub start: usize,
    pub end: usize,
}

/// Basic syntax highlighter for Markdown.
pub fn highlight(text: &str) -> Vec<Token> {
    let mut tokens = Vec::new();
    let lines: Vec<&str> = text.lines().collect();

    for (line_idx, line) in lines.iter().enumerate() {
        let line_start = lines[..line_idx].iter().map(|l| l.len() + 1).sum::<usize>();

        if line.starts_with('#') {
            let level = line.chars().take_while(|c| *c == '#').count();
            tokens.push(Token {
                kind: TokenKind::Heading,
                start: line_start,
                end: line_start + level.min(line.len()),
            });
            continue;
        }

        if line.starts_with("```") {
            tokens.push(Token {
                kind: TokenKind::Code,
                start: line_start,
                end: line_start + line.len(),
            });
            continue;
        }

        if line.starts_with("> ") {
            tokens.push(Token {
                kind: TokenKind::Quote,
                start: line_start,
                end: line_start + line.len(),
            });
            continue;
        }

        if line.starts_with("- ") || line.starts_with("* ") || line.starts_with("+ ") {
            tokens.push(Token {
                kind: TokenKind::List,
                start: line_start,
                end: line_start + 2,
            });
            continue;
        }

        if let Some(pos) = line.find("[[") {
            if let Some(end) = line[pos..].find("]]") {
                tokens.push(Token {
                    kind: TokenKind::Link,
                    start: line_start + pos,
                    end: line_start + pos + end + 2,
                });
            }
        }

        if line.contains("**") {
            tokens.push(Token {
                kind: TokenKind::Bold,
                start: line_start,
                end: line_start + line.len(),
            });
        }
    }

    tokens
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_new_editor_empty() {
        let ed = Editor::new();
        assert_eq!(ed.text(), "");
        assert_eq!(ed.char_count(), 0);
    }

    #[test]
    fn test_insert_text() {
        let mut ed = Editor::new();
        ed.insert("Hello");
        assert_eq!(ed.text(), "Hello");
    }

    #[test]
    fn test_undo_redo() {
        let mut ed = Editor::new();
        ed.insert("Hello");
        assert_eq!(ed.text(), "Hello");
        ed.undo();
        assert_eq!(ed.text(), "");
        ed.redo();
        assert_eq!(ed.text(), "Hello");
    }

    #[test]
    fn test_delete() {
        let mut ed = Editor::from_text("Hello");
        ed.delete_before(); // deletes 'o'
        assert_eq!(ed.text(), "Hell");
        ed.undo();
        assert_eq!(ed.text(), "Hello");
    }

    #[test]
    fn test_from_text() {
        let ed = Editor::from_text("Hello\nWorld");
        assert_eq!(ed.line_count(), 2);
        assert_eq!(ed.line_text(0), "Hello\n");
        assert_eq!(ed.line_text(1), "World");
    }

    #[test]
    fn test_highlight_headings() {
        let tokens = highlight("# Heading\n\nParagraph");
        assert!(tokens.iter().any(|t| t.kind == TokenKind::Heading));
    }

    #[test]
    fn test_highlight_links() {
        let tokens = highlight("text [[link]] more");
        assert!(tokens.iter().any(|t| t.kind == TokenKind::Link));
    }

    #[test]
    fn test_undo_stack_limit() {
        let mut ed = Editor::new();
        for i in 0..1500 {
            ed.insert(&format!("{}", i % 10));
        }
        assert!(ed.undo_stack.len() <= 1000);
    }
}
