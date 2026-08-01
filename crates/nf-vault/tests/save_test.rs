/// Integration test: simulate creating a new note, writing content, saving, and reading back.
#[cfg(test)]
mod tests {
    use nf_vault::Vault;

    #[test]
    fn test_create_write_read_save_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("test-vault");
        std::fs::create_dir_all(&root).unwrap();

        // 1. Open vault
        let vault = Vault::open(&root).unwrap();

        // 2. Create new-note.md (simulates clicking "新建笔记")
        vault.create_note("new-note.md").unwrap();
        assert!(root.join("new-note.md").exists());

        // 3. Read back empty content (simulates opening the file in editor)
        let empty = vault.read_note("new-note.md").unwrap();
        assert_eq!(empty, b"");

        // 4. Write content (simulates Ctrl+S save)
        let content = "# Hello\n\nThis is a test note.\n";
        vault.write_note("new-note.md", content.as_bytes()).unwrap();

        // 5. Read back saved content (simulates reopening)
        let saved = vault.read_note("new-note.md").unwrap();
        assert_eq!(saved, content.as_bytes());

        // 6. Atomic save verification: no .tmp file left
        assert!(!root.join("new-note.md.tmp").exists());

        // 7. Write again with different content (simulates editing and resaving)
        let content2 = "# Updated\n\nNew content here.";
        vault.write_note("new-note.md", content2.as_bytes()).unwrap();
        let saved2 = vault.read_note("new-note.md").unwrap();
        assert_eq!(saved2, content2.as_bytes());
    }

    #[test]
    fn test_create_write_read_plaintext_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("plain-vault");
        std::fs::create_dir_all(&root).unwrap();

        let vault = Vault::open(&root).unwrap();

        vault.create_note("note.md").unwrap();
        vault.write_note("note.md", b"Plain content").unwrap();

        let content = vault.read_note("note.md").unwrap();
        assert_eq!(content, b"Plain content");

        // Local vault is NOT encrypted — file is stored as plaintext
        let raw = std::fs::read_to_string(root.join("note.md")).unwrap();
        assert_eq!(raw, "Plain content", "plaintext stored on disk");
    }

    #[test]
    fn test_frontend_simulation_new_note_save_flow() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("fsim");
        std::fs::create_dir_all(&root).unwrap();

        let vault = Vault::open(&root).unwrap();

        // Simulate: user clicks "新建笔记" → enters "new-note.md"
        vault.create_note("new-note.md").unwrap();

        // Simulate: user clicks file in FileTree → readNote("new-note.md")
        let initial = vault.read_note("new-note.md").unwrap();
        assert_eq!(initial.len(), 0, "new file should be empty");

        // Simulate: user types content, onContentChange fires, then Ctrl+S
        // Frontend calls invoke("write_note", { notePath: "new-note.md", content: userContent })
        let user_content = "# My New Note\n\nHello world!\n- item 1\n- item 2\n";
        vault.write_note("new-note.md", user_content.as_bytes()).unwrap();

        // Simulate: user re-opens file → should see saved content
        let reopened = vault.read_note("new-note.md").unwrap();
        assert_eq!(reopened, user_content.as_bytes());
        assert!(String::from_utf8_lossy(&reopened).contains("Hello world"));
    }
}
