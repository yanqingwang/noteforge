# Obsidian 插件兼容层

noteforge 可以直接加载 **Obsidian 官方市场的插件**：装在 `<vault>/.obsidian/plugins/<id>/`，
和 Obsidian 共用同一套目录与 `data.json`，所以同一个 vault 在两边装一次即可。

- 侧栏「插件」标签：已装插件、启用/禁用、加载错误、插件视图入口
- 设置里的插件页：搜索官方市场（8451 个）并一键安装 / 卸载
- 插件命令统一出现在命令面板（`Ctrl+P`，名称带 `[插件]` 前缀）

## 兼容性现状

结论来自 41 个分层抽样插件的自动兼容性测试（下载量 top + 12 个功能类别 + 本项目自有的
`vault-agent`），报告在 `wk/AIReports/noteforge-obsidian-plugin-compat-*.md`。

| 判定 | 数量 | 含义 |
| --- | ---: | --- |
| ✅ pass | 20 | onload 成功且注册了命令/视图/后处理器 |
| ⚠️ pass-view-error | 6 | 加载正常，视图实例化或设置页渲染出错 |
| ❌ fail | 14 | 求值 / 构造 / onload 抛错 |
| 📦 产物不可达 | 1 | 本机网络到 github.com 不可达（只在 Release 发产物的插件） |

已验证可用的头部插件：dataview、obsidian-tasks、quickadd、advanced-canvas（39 命令）、
obsidian-minimal-settings（51 命令）、table-editor-obsidian（22 命令）、folder-notes、
obsidian-linter、obsidian-style-settings、obsidian-charts、tasknotes、vault-agent 等。

### 已知不兼容（及原因）

| 类型 | 例子 | 根因 |
| --- | --- | --- |
| 需要 Node 文件系统/子进程 | obsidian-git、obsidian-livesync | 插件要读写 `.git`、起 `child_process`，浏览器/webview 里没有 |
| 插件自带 lezer 解析器 | obsidian-excalidraw | 插件内嵌的 `@lezer/markdown` 与宿主 `@lezer/common` 是两份实例，`NodeSet` 对不上 |
| 依赖 Obsidian CM5 兼容层深度 | templater | 需要完整 CodeMirror 5 的 mode/overlay/state 体系 |
| 需要 Worker | 部分大型插件的索引器 | harness 环境无 Worker（真机 webview 有） |

## 下载源与网络

Obsidian 官方浏览器从 GitHub Release 下载产物。本机到 `github.com` /
`raw.githubusercontent.com` / Release 资产字节**不可达**，因此安装走两条路：

1. **jsDelivr**（`cdn.jsdelivr.net/gh/<repo>@<ref>/`）—— 仓库里直接提交了 `main.js` 的插件
2. **GitHub Release 资产**（经 `ghfast.top` / `gh-proxy.com` 代理）—— 多数头部插件只在这里发产物

两条都失败时返回明确错误（不会静默失败），UI 上会显示原因。索引
（`community-plugins.json`）同样走 jsDelivr，前端缓存 24 小时。

## 安全取舍

插件是第三方代码，**在同一个 webview 里执行**（与 Obsidian 桌面端一致），能拿到完整
app / vault / CodeMirror API。为支持这一点，`tauri.conf.json` 的 CSP 增加了：

- `script-src` 加 `'unsafe-eval'` —— 插件产物是 esbuild 打的 CJS（`require("obsidian")`），
  浏览器里必须能自己拼 module 作用域
- `connect-src https:` —— 插件要直连 LLM API（DeepSeek / GLM / Kimi 等）

代价是 noteforge 不再适合打开来源不明的插件目录。如果要更严格的隔离，只能把插件放进
沙箱 iframe，但那会牺牲绝大多数插件（编辑器扩展、DOM 事件、Markdown 渲染都跨不过去）。

## 代码结构

```
frontend/src/plugins/
  obsidianRuntime.ts      应用侧运行时：扫描 / 加载 / 卸载，暴露命令·视图·设置页
  loader.ts               CJS 加载器（module/require 作用域）+ node/electron 垫片
  obsidian/
    index.ts              createObsidianApi()：拼装 require("obsidian") 的全部导出
    types.ts              Host 接口、内存文件系统、API 调用记录器
    dom.ts                Obsidian 挂在 Node 原型上的 DOM 便捷方法
    events.ts             事件总线、Component 生命周期、Scope、常用工具函数
    items.ts              TFile / TFolder / TAbstractFile
    vault.ts              Vault / MetadataCache / FileManager
    workspace.ts          Workspace / View / ItemView / MarkdownView / MarkdownRenderer
    ui.ts                 Notice / Modal / SuggestModal / Setting 组件族
    plugin.ts             Plugin 基类与插件侧注册 API
    extra.ts              样本静态分析得出的第二批必需 API
    request.ts            requestUrl、moment 最小实现
    cm-modules.ts         转发给插件的 @codemirror/* 与 @lezer/* 模块表
    host-tauri.ts         Tauri 宿主：invoke 接文件操作、CM6 适配成 Obsidian Editor
```

`createObsidianApi(host)` 是唯一入口，`host` 可注入 —— 应用内接 Tauri，测试与 harness 接
内存文件系统，所以**测的就是跑的**。

## 兼容性测试

```bash
cd frontend
npx vite build --config vite.harness.config.ts   # 打 harness 包（应用侧同一份 shim）
node scripts/compat/select-sample.mjs 40          # 按下载量分层抽 40 个插件 + vault-agent
node scripts/compat/run.mjs                        # 跑全量，产出 JSON + Markdown 报告
node scripts/compat/run.mjs --no-fetch vault-agent # 只测指定插件、复用缓存
node scripts/compat/run.mjs --report-only          # 只用已有结果重生成报告
node scripts/compat/analyze-imports.mjs             # 静态扫描：插件引用了哪些我们没导出的 API
```

harness 在 Node + jsdom 里加载真实插件产物，逐阶段记录
`require → 求值 → 构造 → onload → 视图创建`，并把「插件访问到但 shim 未实现的导出」
记进报告（`最常缺失的 obsidian API`）。这一项现在是 0，说明剩下的失败都不是「API 不存在」
而是语义/环境差异。

`analyze-imports.mjs` 是补 API 的主力：它把插件里 `obsidian.X` 的引用与 shim 的实际导出
（`OBSIDIAN_EXPORT_NAMES`）做差集，一次列出全部缺口，避免逐个插件试错。

## 测试与构建

```bash
cd frontend
npm run test        # vitest：115 个用例（含 shim 单测 26 + 运行时集成 5）
npm run build       # tsc -b && vite build —— 注意 tsc --noEmit 通过不代表这里通过
```

Rust 侧：

```bash
cargo test -p noteforge plugin_cmd      # 插件管理命令（含目录/启用/卸载/市场搜索）
NOTEFORGE_NET_TESTS=1 cargo test -p noteforge plugin_cmd::tests::install_plugin_from_market
```

最后这条会真的走网络安装一次插件（`kepano/obsidian-hider`），验证「从官方市场下载」这条
链路；默认跳过以保持离线可测。
