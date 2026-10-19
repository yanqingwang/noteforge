# NoteForge

[中文](README.md)

## What is NoteForge?

Obsidian is great, but it's heavy — large installer, slow startup, high runtime resource usage. NoteForge is a local-first Markdown knowledge management desktop app built in Rust. It aims to deliver Obsidian's core experience without its footprint.

**Data sovereignty · Fast startup · Extensible · Secure**

## Features

- **CM6 Live Preview**: CodeMirror 6 decorations — syntax hidden on non-caret lines, source echoed on caret line (Typora/MarkText style, stable with IME, low overhead)
- **Four editing modes**: Source / Preview / Split / Live Preview — switch without losing the undo stack
- **Wikilinks**: `[[link|alias]]` capsule rendering + autocomplete + navigation + graph view
- **Image embed & paste**: Both `![[image.png]]` and standard `![](image.png)` inline-preview; paste/drag-drop auto-saves to attachments folder, insert style configurable
- **Editing efficiency**: 16 format shortcuts, smart list continuation, auto-pair, 2-second autosave (atomic write)
- **Encrypted Nextcloud mirror sync**: vault ↔ Nextcloud folder 1:1 mirror, quadrant incremental diff, dual-version conflict resolution, side trash to prevent accidental deletion; content AES-256-GCM encrypted before upload — server sees only ciphertext
- **Large-vault optimizations**: SHA256 dedup → cached file tree → in-memory vault
- **Source syntax highlighting**: wikilink / heading / bold / code coloring + line numbers
- **Markdown rendering**: comrak with GFM extensions (single rendering source of truth)
- **Obsidian plugin compatibility**: drop-in plugins from the official marketplace (installed to `.obsidian/plugins/`, shares `data.json` with Obsidian); built-in marketplace for search & one-click install; plugin commands, views, and settings tabs all wired into the host UI

**As of 2026-10-19**: A layered sample of 121 real plugins from the official marketplace — 71 fully working, 19 work but fail on view instantiation, 26 fail at load/onload. Compatibility shim (`dist-harness/obsidian-shim.mjs`) is the same artifact shipped in the app; each plugin runs in an isolated child process with a 180s hard kill, covering require / evaluate / construct / onload / view-create.

## Image Insert & Rendering

Configurable under **Settings → Files & Links** (mirroring Obsidian). Default values match legacy behavior byte-for-byte; changes do not require a rebuild (except loading mode):

| Setting | Default | Options |
|---|---|---|
| Link style | Wiki-link `![[…]]` | Markdown `![](…)` |
| Path style | Full path `attachments/2026-10/x.png` | Relative to note `../attachments/…` · filename only `x.png` (when unique in vault) |
| Attachments folder | `attachments` | Any vault-relative path |
| Monthly subfolders | On (`YYYY-MM/`) | Off |
| Filename | Timestamp `YYYYMMDDHHmmss` | Sequence `img-<epoch>-<n>` |
| Paste → WebP | Off | On (png/jpg/bmp only; svg/gif/ico untouched) |
| Loading mode | Inline Data URL | Resource protocol `asset://` (requires rebuild) |

> `asset://` requires enabling `assetProtocol` + `scope` in `tauri.conf.json`, adding `protocol-asset` feature to the `tauri` dependency, and allowing `http://asset.localhost` in the CSP `img-src`. This relaxes the webview's file-read scope — recommended only for single-machine note-taking.

## Architecture

```
crates/
├── nf-core/        # Core types (NoteMeta, Link, VaultConfig)
├── nf-vault/       # Filesystem ops (atomic read/write)
├── nf-render/      # Markdown → HTML (comrak)
├── nf-markdown/    # Markdown metadata parsing (frontmatter, links, tags)
├── nf-index/       # Full-text search index + block ref IDs
├── nf-graph/       # Knowledge graph (force-directed)
├── nf-plugin/      # WASM plugin runtime (wasmtime)
├── nf-vaultgen/    # Test vault generator (11 profiles, 68 tests)
├── nf-workspace/   # Multi-vault workspace
├── nf-sync/        # Nextcloud mirror sync (filter + merge3 + conflict + purge + AES)
├── nf-crypto/      # AES-256-GCM + Argon2id
├── nf-app/         # CLI-only version
src-tauri/          # Tauri 2 app (includes sync_cmd.rs sync commands)
frontend/           # React frontend (Vite + TSX + CodeMirror 6)
└── src/editor/     # livePreview / extensions / highlight
```

## Quick Start

```bash
# Dependencies (macOS)
# Xcode Command Line Tools provide clang / otools / ar; webkit2gtk is
# auto-installed via Tauri's bundled script.

# Frontend
cd frontend && npm install && npm run build

# Tauri app (use tauri-cli — it injects the custom-protocol feature;
# otherwise the build tries to hit the vite devUrl and ships blank)
node frontend/node_modules/@tauri-apps/cli/tauri.js build --bundles app

# Dev mode (run `npm run dev` in frontend first)
node frontend/node_modules/@tauri-apps/cli/tauri.js dev
```

### CLI-only

```bash
cargo run --bin nf-app -- --help
```

## Tests

```bash
# Full workspace test suite (including nf-sync 23 tests)
cargo test --workspace

# Specific crate
cargo test -p nf-sync
```

## Obsidian Plugin Compatibility

121 real plugins sampled by download tier from the official marketplace. Each is executed in Node+jsdom via the same compatibility layer shipped in the app (`dist-harness/obsidian-shim.mjs`), in an isolated child process with a 180s hard kill, covering require / evaluate / construct / onload / view-create.

**Latest results (2026-10-19)**:

| Verdict | Count |
| --- | ---: |
| ✅ Fully working | 71 |
| ⚠️ Load OK, view error | 19 |
| ⚠️ Load OK, settings error | 3 |
| 🟡 Load only (no registered capability) | 2 |
| ❌ Fail | 26 |
| **Total** | **121** |

Compared to the 10-07 baseline report: failures dropped from 32 to 26 (−18.8%). Fixed: excalidraw-plugin (lezer dual-instance), livesync (`addEventListener`), folder-note-plugin / hotkeys-for-templates (Plugin base-class `new` semantics), smart-second-brain / karpathywiki (harness timeout). The two high-frequency missing APIs from the baseline — `parseFrontMatterAliases` (5 hits) and `BasesView` (2 hits) — are now implemented in the shim.

### Fully working plugins (71, by category)

**📊 Data & Query**: Dataview, Dataview Serializer, Dataview Publisher, Dataview to Properties, Dataview Autocompletion, Dataview Toggle

**✏️ Editing Enhancements**: Advanced Tables, Editing Toolbar, Outliner, Linter, Auto Link Title, Image in Editor, Code Styler, Text Format, Markdown Formatting Assistant, Typing Assistant, Prettier Format

**📈 Charts & Visualization**: Excalidraw, Advanced Canvas, ExcaliBrain, Charts, Enhancing Mindmap, Diagrams, Heatmap Calendar, Simple CanvaSearch, Charts View, Smart Connections Visualizer

**🗂 File Management**: Image Converter, Folder notes, Better Export PDF, File Explorer Note Count, Find orphaned files and broken links, File Color, Custom File Explorer sorting, Mousewheel Image zoom, Paste image rename, Clear Unused Images, Consistent Attachments and Links, Folder Note, File Hider, Settings Sidebar Organizer, Note archiver, Auto File Organizer, Auto Archive

**🔄 Sync & Backup**: Self-hosted LiveSync, Google Drive Sync, Todoist Sync, Advanced URI, Actions URI

**✅ Tasks & Productivity**: Tasks, QuickAdd, Periodic Notes, Quick Explorer, Auto Note Mover, Auto Template Trigger, Hotkeys for templates, From Template, YouTube Template, Projects Plus, Default Template, Macros

**🤖 AI & Smartness**: AI Providers, Karpathy LLM Wiki, Vault Agent, Excalibrain

**🎨 UI & Themes**: Minimal Theme Settings, Homepage, OA File Hider, Colored Tags Wrangler, Colored Text

**🔧 Utilities**: BRAT, Better Word Count, Novel word count, Smart Connections Visualizer, ExcaliBrain

## Architecture Notes

### Sync module split

The nf-sync `mirror` module is split into six single-responsibility files. `mod.rs` only orchestrates:

| Module | Role |
|---|---|
| `filter.rs` | File/folder filtering (extensions, blacklist, hidden files, lazy attachments) |
| `diff.rs` | Quadrant diff: local vs baseline × remote vs baseline → ActionPlan |
| `merge.rs` | 3-way merge (LCS DP, 4M upper bound) |
| `conflict.rs` | Conflict strategy decision + MassDeleteGuard circuit breaker |
| `base_store.rs` | Merge-baseline persistence (`.noteforge/bases/<rel>`) |
| `purge.rs` | Cleanup remote files excluded by extension rules |

### Encryption

Vault content is AES-256-GCM encrypted before upload. Salt is published in a remote `nf-sync-meta.json` for key derivation. The server sees only ciphertext; compatible with the official Nextcloud plugin.

## Tech Stack

| Layer | Tech |
|---|---|
| Desktop framework | Tauri 2 |
| Frontend | React 19 + TypeScript + Vite |
| Editor | CodeMirror 6 (decorative Live Preview) |
| Markdown | comrak (Rust) — GFM extensions |
| Sync | WebDAV (Nextcloud) + AES-256-GCM |
| Plugins | WASM + wasmtime |
| Metadata | redb (embedded KV) |
| Graph layout | Force-directed |

## License

Apache-2.0 OR MIT
