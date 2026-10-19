# NoteForge

[English](README.en.md)

## 目标

Obsidian 用起来很舒服，但是太大了——不仅安装包大，启动也慢、运行时资源占用高。NoteForge 是用 Rust 实现的本地优先（local-first）Markdown 知识管理桌面应用，追求 Obsidian 的核心体验，而不是它的体积。

**数据主权 | 快速启动 | 可扩展 | 安全**

## 特性

- **CM6 即输即显（Live Preview）**：CodeMirror 6 装饰式渲染——非光标行隐藏语法标记、光标行回显源码（Typora / MarkText 风格，IME 稳定、低资源占用）
- **四种编辑模式**：源码 / 预览 / 分栏 / 即输即显，切换不丢撤销栈
- **Wikilink 双链**：`[[链接|别名]]` 胶囊渲染 + 自动补全 + 跳转导航 + 图谱视图
- **图片嵌入与粘贴**：`![[图片.png]]` 与标准 `![](图片.png)` 均可内联预览；粘贴/拖拽自动存入附件目录，插入方式可配置
- **编辑效率**：16 组格式快捷键、列表续行、自动配对、2 秒自动保存（原子写）
- **Nextcloud 加密镜像同步**：vault 与 Nextcloud 目录 1:1 镜像，四象限增量，冲突双版本保留，双侧回收站防误删；内容 AES-256-GCM 加密后上传，服务器只存密文
- **大 Vault 优化**：SHA256 去重 → 缓存文件树 → 内存常驻 vault
- **源码语法高亮**：wikilink / 标题 / 加粗 / 代码着色 + 行号
- **Markdown 渲染**：comrak + GFM 扩展（渲染单一准绳）
- **Obsidian 插件兼容**：直接使用官方市场的插件（装在 `.obsidian/plugins/`，与 Obsidian 共用同一目录与 `data.json`）；内置插件市场可搜索并一键安装；插件命令、视图、设置页全部接入宿主 UI

**截至 2026-10-19**：对官方市场按下载量分层抽样的 121 个真实插件——71 个完全可用、19 个可用但视图出错、26 个失败。兼容层与 Obsidian 共用同一份产物（`dist-harness/obsidian-shim.mjs`），逐插件独立进程、180s 硬杀，覆盖 require / 求值 / 构造 / onload / 视图创建 五个阶段。

## 图片插入与渲染设置

对标 Obsidian「文件与链接」，可在 **设置** 中配置。**默认值与旧行为逐字节一致**，改配置无需重建（加载方式除外）：

| 设置 | 默认 | 可选 |
|---|---|---|
| 图片链接样式 | Wiki 双链 `![[…]]` | Markdown `![](…)` |
| 链接路径写法 | 完整路径 `attachments/2026-10/x.png` | 相对当前笔记 `../attachments/…` · 仅文件名 `x.png`（vault 内唯一时） |
| 附件目录 | `attachments` | 任意 vault 相对目录 |
| 附件按月份分目录 | 开（`YYYY-MM/`） | 关 |
| 图片文件名 | 时间戳 `YYYYMMDDHHmmss` | 序号 `img-<epoch>-<n>` |
| 粘贴转 WebP | 关 | 开（仅 png/jpg/bmp；不动 svg/gif/ico） |
| 图片加载方式 | 内嵌 Data URL | 资源协议 `asset://`（需重构建生效） |

> `asset://` 模式需在 `tauri.conf.json` 启用 `assetProtocol`（`scope`），并给 `tauri` 依赖加 `protocol-asset` feature；CSP `img-src` 放行 `http://asset.localhost`。该模式会放宽 webview 的文件读取范围，建议仅用于单机笔记场景。

## 架构

```
crates/
├── nf-core/        # 核心类型定义（NoteMeta, Link, VaultConfig）
├── nf-vault/       # 文件系统操作（原子读写）
├── nf-render/      # Markdown → HTML（comrak）
├── nf-markdown/    # Markdown 元数据解析（frontmatter, links, tags）
├── nf-index/       # 全文搜索索引 + 块引用 ID
├── nf-graph/       # 知识图谱（力导向布局）
├── nf-plugin/      # WASM 插件运行时（wasmtime）
├── nf-vaultgen/    # 测试 vault 生成器（11 种 profile，68 测试）
├── nf-workspace/   # 多 vault workspace
├── nf-sync/        # Nextcloud 镜像同步（filter + merge3 + conflict + purge + AES）
├── nf-crypto/      # AES-256-GCM + Argon2id
├── nf-app/         # 纯 CLI 版本
src-tauri/          # Tauri 2 应用（含 sync_cmd.rs 同步命令）
frontend/           # React 前端（Vite + TSX + CodeMirror 6）
└── src/editor/     # livePreview / extensions / highlight
```

## 快速构建

```bash
# 依赖（macOS）
# Xcode Command Line Tools 自带 clang / otools / ar；webkit2gtk 走 Tauri 内置脚本自动拉取

# 前端
cd frontend && npm install && npm run build

# Tauri 应用（必须用 tauri-cli：它会注入 custom-protocol 特性，
# 否则产物会去连 vite devUrl，真机打开是空白）
node frontend/node_modules/@tauri-apps/cli/tauri.js build --bundles app

# 运行（开发模式，需先 npm run dev 起 vite）
node frontend/node_modules/@tauri-apps/cli/tauri.js dev
```

### 仅 CLI 版本

```bash
cargo run --bin nf-app -- --help
```

## 测试

```bash
# 全部 workspace 测试（含 nf-sync 23 项）
cargo test --workspace

# 特定 crate
cargo test -p nf-sync
```

## Obsidian 插件兼容性

对官方市场按下载量分层抽样的 121 个真实插件，用应用侧同一份兼容层代码（构建为 `dist-harness/obsidian-shim.mjs`）在 Node+jsdom 中执行产物，逐插件独立进程、180s 硬杀，覆盖 require / 求值 / 构造 / onload / 视图创建 五个阶段。

**最新结果（2026-10-19）**：

| 判定 | 数量 |
| --- | ---: |
| ✅ 完全可用 | 71 |
| ⚠️ 可用但视图出错 | 19 |
| ⚠️ 可用但设置页出错 | 3 |
| 🟡 仅加载 | 2 |
| ❌ 失败 | 26 |
| **合计** | **121** |

与 10-07 首轮报告对比：失败数从 32 降至 26（-18.8%），修复了 excalidraw-plugin（lezer 双实例）、livesync（`addEventListener`）、folder-note-plugin / hotkeys-for-templates（Plugin 基类 `new` 语义）、smart-second-brain / karpathywiki（harness 超时）等关键插件。缺失的高频 API `parseFrontMatterAliases`（5 次）和 `BasesView`（2 次）已在 shim 中补齐。

### 完全可用插件清单（71 个，按功能分类）

**📊 数据与查询**：Dataview、Dataview Serializer、Dataview Publisher、Dataview to Properties、Dataview Autocompletion、Dataview Toggle

**✏️ 编辑增强**：Advanced Tables、Editing Toolbar、Outliner、Linter、Auto Link Title、Image in Editor、Code Styler、Text Format、Markdown Formatting Assistant、Typing Assistant、Prettier Format

**📈 图表与可视化**：Excalidraw、Advanced Canvas、ExcaliBrain、Charts、Enhancing Mindmap、Diagrams、Heatmap Calendar、Simple CanvaSearch、Charts View、Smart Connections Visualizer

**🗂 文件管理**：Image Converter、Folder notes、Better Export PDF、File Explorer Note Count、Find orphaned files and broken links、File Color、Custom File Explorer sorting、Mousewheel Image zoom、Paste image rename、Clear Unused Images、Consistent Attachments and Links、Folder Note、File Hider、Settings Sidebar Organizer、Note archiver、Auto File Organizer、Auto Archive、Consistent Attachments and Links

**🔄 同步与备份**：Self-hosted LiveSync、Google Drive Sync、Todoist Sync、Advanced URI、Actions URI

**✅ 任务与效率**：Tasks、QuickAdd、Periodic Notes、Quick Explorer、Auto Note Mover、Auto Template Trigger、Hotkeys for templates、From Template、YouTube Template、Projects Plus、Default Template、Macros

**🤖 AI 与智能**：AI Providers、Karpathy LLM Wiki、Vault Agent、Excalibrain、Colored Tags Wrangler、Colored Text

**🎨 界面与主题**：Minimal Theme Settings、Homepage、OA File Hider、Colored Tags Wrangler、Colorful Tags

**🔧 工具**：BRAT、Better Word Count、Novel word count、Editor Command Palette、Smart Connections Visualizer、Excalibrain

## 架构要点

### 同步拆分

nf-sync 的 `mirror` 模块按单一职责拆成 6 个独立文件，`mod.rs` 只做编排：

| 模块 | 职责 |
|---|---|
| `filter.rs` | 文件 / 目录过滤（扩展名、黑名单、隐藏文件、懒同步附件） |
| `diff.rs` | 四象限 diff：本地 vs 基线 × 远端 vs 基线 → ActionPlan |
| `merge.rs` | 三向合并（LCS DP，上限 4M） |
| `conflict.rs` | 冲突策略决策 + MassDeleteGuard 断路器 |
| `base_store.rs` | 合并基线持久化（`.noteforge/bases/<rel>`） |
| `purge.rs` | 因扩展名被排除的远端文件清理 |

### 加密层

AES-256-GCM 对 vault 内容加密后再上传，salt 发布在远端 `nf-sync-meta.json` 供密钥派生。服务器只存密文，与 Nextcloud 插件兼容。

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面框架 | Tauri 2 |
| 前端 | React 19 + TypeScript + Vite |
| 编辑器 | CodeMirror 6（装饰式 Live Preview） |
| Markdown | comrak (Rust) — GFM 扩展 |
| 同步 | WebDAV（Nextcloud）+ AES-256-GCM |
| 插件 | WASM + wasmtime |
| 元数据 | redb（嵌入式 KV） |
| 图算法 | 力导向布局 |

## License

Apache-2.0 OR MIT
