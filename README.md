# NoteForge

纯 Rust 实现的本地优先（local-first）Markdown 知识管理桌面应用，对标 Obsidian。

**数据主权 | 快速启动 | 可扩展 | 安全**

## 特性

- **CM6 即输即显（Live Preview）**：CodeMirror 6 装饰式渲染——非光标行隐藏语法标记、光标行回显源码（Typora/MarkText 风格，IME 稳定、低资源占用）
- **四种编辑模式**：源码 / 预览 / 分栏 / 即输即显，切换不丢撤销栈
- **Wikilink 双链**：`[[链接|别名]]` 胶囊渲染 + 自动补全 + 跳转导航 + 图谱视图
- **图片嵌入与粘贴**：`![[图片.png]]` 内联预览；粘贴/拖拽自动存 `attachments/年-月/`
- **编辑效率**：16 组格式快捷键、列表续行、自动配对、2 秒自动保存（原子写）
- **Nextcloud 加密镜像同步**：vault 与 Nextcloud 目录 1:1 镜像，四象限增量，冲突双版本保留，双侧回收站防误删；内容 AES-256-GCM 加密后上传，服务器只存密文
- **大 Vault 优化**：SHA256 去重 → 缓存文件树 → 内存常驻 vault
- **源码语法高亮**：wikilink/标题/加粗/代码着色 + 行号
- **Markdown 渲染**：comrak + GFM 扩展（渲染单一准绳）
- **WASM 插件系统**：Rust 编译到 WASM，安全沙箱

> 注：Joplin Server 同步已在 v0.2.0 移除，由 Nextcloud 镜像同步取代。

## 架构

```
crates/
├── nf-core/        # 核心类型定义（NoteMeta, Link, VaultConfig）
├── nf-vault/       # 文件系统操作（原子读写）
├── nf-render/      # Markdown → HTML（comrak）
├── nf-markdown/    # Markdown 元数据解析（frontmatter, links, tags）
├── nf-index/       # 全文搜索索引 + 块引用 ID
├── nf-graph/       # 知识图谱（force-directed graph）
├── nf-plugin/      # WASM 插件运行时（wasmtime）
├── nf-vaultgen/    # 测试 vault 生成器（11种 profile，68测试）
├── nf-workspace/   # 多 vault workspace
├── nf-sync/        # Nextcloud 镜像同步（四象限 diff + AES 加密）
├── nf-crypto/      # AES-256-GCM + Argon2id
├── nf-app/         # 纯 CLI 版本
src-tauri/          # Tauri 2 应用（含 sync_cmd.rs 同步命令）
frontend/           # React 前端（Vite + TSX + CodeMirror 6）
└── src/editor/     # livePreview / extensions / highlight
```

## 快速构建

```bash
# 依赖（Arch Linux）
sudo pacman -S webkit2gtk base-devel curl wget file libxdo

# 前端
cd frontend && npm install && npm run build

# Tauri 应用
cargo build -p noteforge

# 运行
cargo run -p noteforge
```

### 仅 CLI 版本

```bash
cargo run --bin nf-app -- --help
```

## 测试

```bash
# 全部 30 个测试目标（含 nf-sync 23 项）
cargo test --workspace

# 特定 crate
cargo test -p nf-sync
```

## Arch Linux 打包

```bash
# Manjaro / Arch
cd pkg/manjaro
makepkg -si
```

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面框架 | Tauri 2 |
| 前端 | React 19 + TypeScript + Vite |
| 编辑器 | CodeMirror 6（装饰式 Live Preview） |
| Markdown | comrak (Rust) — GFM 扩展 |
| 同步 | WebDAV（Nextcloud）+ AES-256-GCM |
| 插件 | WASM + wasmtime |
| 元数据 | redb (嵌入式 KV) |
| 图算法 | 力导向布局 |

## License

MIT
