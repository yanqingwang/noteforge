# NoteForge

纯 Rust 实现的本地优先（local-first）Markdown 知识管理桌面应用，对标 Obsidian。

**数据主权 | 快速启动 | 可扩展 | 安全**

> **v0.3.2 进展摘要（2026-10-08）**：完成 Obsidian 插件兼容层与 Bases 体系。对官方市场按下载量分层抽样的 **121 个真实插件**，**75 个完全可用、94 个（78%）功能可用**，失败降至 23（多为 `child_process`/`electron` 等平台硬缺口）。新增只读 **Bases**（`.base` 文件：筛选 / 公式 / 排序 / 分组 / 汇总 / CSV 导出，真机全栈验证通过）；`Plugin`/`PluginSettingTab` 兼容 ES5 老插件继承；插件接管的文件（如 quadrant-chart 的 `.mdx` 象限图）渲染进**主编辑区**而非右侧停靠面板；自有 5 插件功能级验证全部通过；293/293 测试全绿。

## 特性

- **CM6 即输即显（Live Preview）**：CodeMirror 6 装饰式渲染——非光标行隐藏语法标记、光标行回显源码（Typora/MarkText 风格，IME 稳定、低资源占用）
- **四种编辑模式**：源码 / 预览 / 分栏 / 即输即显，切换不丢撤销栈
- **Wikilink 双链**：`[[链接|别名]]` 胶囊渲染 + 自动补全 + 跳转导航 + 图谱视图
- **图片嵌入与粘贴**：`![[图片.png]]` 内联预览；粘贴/拖拽自动存 `attachments/年-月/`
- **编辑效率**：16 组格式快捷键、列表续行、自动配对、2 秒自动保存（原子写）
- **Obsidian 插件兼容**：直接使用官方市场的插件（装在 `.obsidian/plugins/`，与 Obsidian 共用同一目录与 `data.json`）；内置插件市场可搜索并一键安装；插件命令、视图、设置页全部接入宿主 UI
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

# Tauri 应用（必须用 cargo tauri：它会注入 custom-protocol 特性，
# 否则产物会去连 vite devUrl，真机打开是空白）
cargo tauri build --no-bundle

# 运行（开发模式，需先 npm run dev 起 vite）
cargo tauri dev
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

## Obsidian 插件兼容性

对官方市场按下载量分层抽样的 **121 个真实插件**，用应用侧同一份兼容层代码（构建为 `dist-harness/obsidian-shim.mjs`）在 Node+jsdom 中执行产物，逐插件独立进程、180s 硬杀，覆盖 require / 求值 / 构造 / onload / 视图创建 五个阶段。

**最新结果（2026-10-08）**：

| 判定 | 数量 |
| --- | ---: |
| ✅ 完全可用 | 75 |
| ⚠️ 视图创建出错（功能可用） | 16 |
| ⚠️ 设置页出错（功能可用） | 3 |
| 🟡 仅加载 | 4 |
| ❌ 失败 | 23 |

即 **94/121（78%）功能可用**（含视图/设置页小错），仅缺失 `MarkdownPreviewRenderer` 一项导出。`Plugin` 与 `PluginSettingTab` 均可被 ES5 老插件（`__extends` + `_super.apply`）继承。自有插件（html-effectiveness / md-to-html-effect / vault-agent / quadrant-chart / obsidian-nextcloud-sync-yanc）功能级验证全部通过。完整报告：`AIReports/noteforge-obsidian-plugin-compat-2026-10-08.md`。

```bash
cd frontend
npx vite build --config vite.harness.config.ts   # 打 harness 包
node scripts/compat/select-sample.mjs 40          # 生成分层样本
node scripts/compat/run.mjs                        # 跑全量
node scripts/compat/verify-own-plugins.mjs         # 自有插件功能级验证
```


## Arch Linux 打包

```bash
# Manjaro / Arch
cd pkg/manjaro
makepkg -si
```

## Linux 桌面后端（Wayland / X11）

GTK 后端由 GTK 自动选择，**不需要设置任何环境变量**：Wayland 会话下原生跑 Wayland，无合成器或只有 X 的场景自动回落 X11。`.desktop` 启动（菜单 / 双击图标）与命令行启动行为一致。

2026-10-09 在 KWin Wayland（KDE Plasma 6 + Xwayland）实测通过：

| 验证点 | 手段 | 结果 |
|---|---|---|
| 窗口真正创建 | `WAYLAND_DEBUG=1` 协议日志 | `xdg_toplevel` 创建、`configure(1200,800)`、连续帧 `attach+commit` |
| 合成器侧存在 | KWin D-Bus 窗口列表 | `cap=NoteForge class=noteforge` |
| 后端确为 Wayland | Xlib 遍历 `:1` | 无对应 X 窗口（未走 Xwayland） |
| 实际渲染 | 截图 | 标题栏 / 菜单 / 工具栏 / 中文文件树 / 状态栏均正常 |
| `.desktop` 启动 | `gtk-launch noteforge`（不带 `GDK_BACKEND`） | 同上，原生 Wayland |

> 排查提醒：`DISPLAY=:1` 是 KWin 的 Xwayland，X11 截图工具（`import`、`xwd`）**看不到**原生 Wayland 窗口，据此会误判「Wayland 下窗口不出现」。要验证 Wayland 窗口请用 `WAYLAND_DEBUG=1`、KWin D-Bus 或 `spectacle -a`。
>
> `GDK_BACKEND=x11` 仅供无合成器的自动化 / CI 场景使用，不是正常运行的前提。

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
