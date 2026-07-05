# NoteForge

纯 Rust 实现的本地优先（local-first）Markdown 知识管理桌面应用，对标 Obsidian。

**数据主权 | 快速启动 | 可扩展 | 安全**

## 特性

- **4 种编辑模式**：源码 / 预览 / 分栏 / 即输即显（Live Preview）
- **Wikilink 双链**：`[[链接]]` 自动补全 + 跳转导航 + 图谱视图
- **WASM 插件系统**：Rust 编译到 WASM，安全沙箱
- **大 Vault 优化**：SHA256 去重 → 缓存文件树 → 内存常驻 vault
- **源码语法高亮**：wikilink/标题/加粗/代码/distinct 着色 + 行号
- **Markdown 渲染**：comrak + GFM 扩展
- **原子保存**：临时文件 + rename，防止写操作中断导致数据损坏
- **GPU 监控**：deepin 环境 GPU 使用率实时监控

## 架构

```
crates/
├── nf-core/        # 核心类型定义（NoteMeta, Link, VaultConfig）
├── nf-vault/       # 文件系统操作（open/read/write/list）
├── nf-render/      # Markdown → HTML（comrak）
├── nf-markdown/    # Markdown 元数据解析（frontmatter, links, tags）
├── nf-index/       # 全文搜索索引 + 块引用 ID
├── nf-graph/       # 知识图谱（force-directed graph）
├── nf-plugin/      # WASM 插件运行时（wasmtime）
├── nf-vaultgen/    # 测试 vault 生成器（11种 profile，68测试）
├── nf-workspace/   # 多 vault workspace
├── nf-app/         # 纯 CLI 版本
src-tauri/          # Tauri 2 应用（frontend React+TypeScript）
frontend/           # React 前端（Vite + TSX）
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
# 全部 130+ 测试
cargo test --workspace

# 特定 crate
cargo test -p nf-vaultgen
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
| 前端 | React 18 + TypeScript + Vite |
| Markdown | comrak (Rust) — GFM 扩展 |
| 插件 | WASM + wasmtime |
| 元数据 | redb (嵌入式 KV) |
| 图算法 | 力导向布局 |

## License

MIT
