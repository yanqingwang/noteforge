# NoteForge 验证日志 - 2026-07-04 23:16

## 最终验证结果

| 检查项 | 结果 |
|--------|------|
| 全部测试通过 | ✅ 25 suites, 134+ tests |
| 编译零警告 | ⚠️ ~44 条警告（主要为 nf-markdown 未使用变量 + Slint padding） |
| nf-vaultgen profiles | ✅ 11/11 (全部有 match arms，list-profiles 确认) |
| nf-plugin | ✅ 8 tests (新增 scan/generate/empty registry 测试) |
| WIT 接口定义 | ✅ crates/nf-plugin/wit/plugin.wit |
| Block IDs 生成 | ✅ 每篇笔记生成唯一 ^block_id (基于路径哈希) |
| 端到端测试 | ✅ generate → open → show 正常 |
| 桌面 GUI (Slint) | ✅ 编译通过 |
| 需求文档已更新 | ✅ 标记已知差距 |

## 已知差距（待后续迭代）

1. M0 Phase 0 门禁 - IME/渲染/性能 未验证
2. M1 文件安全 - 文件监听/冲突处理/回收站 未实现
3. M2 编辑器 - Live Preview/折叠/补全 未实现
4. M3 搜索 - tantivy 未集成，为子串搜索
5. M5 插件 - WASM 运行时无 WIT 接口绑定
6. 语料库 - ~200 词，远低于规范 30,000 词

## 项目统计
- Crates: 12
- Profiles: 11 (6 old + 5 new)
- 架构: M0-M6 全覆盖，深度各异
- UI: Slint 桌面 GUI + CLI 双模式

---

# 验证日志 - 2026-10-19 表格编辑体验 + 界面稳定性（Zed 式）

## 本轮改动

**表格编辑（对标 Obsidian Advanced Tables）**
1. 修复导航卡死 bug：光标在单元格中部时 Tab/Shift+Tab 原会反复选中当前格（`head < c.to` / `head > c.from` 边界缺陷），改为严格取 `from > head` / `to < head`
2. 导航进入新格时自动选中整格内容，直接输入即覆盖
3. Enter 改为「移到下一行同列」（末行才新建行），不再每敲一次就插行
4. 自动对齐：输入停顿 350ms 整表对齐；光标移出表格时补一次对齐；IME 组合输入期间顺延（中文输入不打断）
5. 光标保留修复：整表替换的 mapPos 会把格内光标吸到表尾，改为按「行/列/格内偏移」显式映射到新文本同格同偏移
6. update 阶段禁止 dispatch（CM6 硬约束）：离开表格的对齐用 microtask 延后一拍，并校验文档代际防止位置失效

**界面稳定性（参考 Zed：无不必要 DOM 抖动、面板行为可预期）**
7. 表格工具条 DOM 一次构建：原来每次光标移动重建 9 个按钮，现 update 只同步 disabled/对齐文案/显隐
8. 即输即显模式下光标行保留表格外观（单元格内边距 + 管道淡化），不再整行裸源码，视觉连续
9. 侧栏 / 右侧 dock 拖拽调宽（pointer capture 增量拖动），宽度持久化 localStorage（180–520 / 240–640）
10. scrollbar-gutter: stable：编辑器与预览面板滚动条出现/消失不再引起内容横向跳动
11. 模式切换后编辑器重新聚焦（theme/vaultConfig 热更新不抢焦点）
12. 修复 viewMenu 直接 setViewMode 导致 HTML 文件下模式切换不生效的问题

## 验证结果

| 检查项 | 结果 |
|--------|------|
| 前端全量测试 | ✅ 328 passed（新增/改写 16 个表格用例：导航修复、Enter 行为、自动对齐、DOM 一次构建） |
| tsc + vite build | ✅ built in 1.18s（lucide-react 需先 npm install，属环境问题非代码问题） |
| Tauri 桌面启动 | ✅ cargo build -p noteforge 10s，窗口正常渲染（截屏验证：文件树/编辑器/模式按钮完好） |
| 已知限制 | 无 xdotool/ydotool，Wayland 下无法脚本化注入键鼠，表格交互靠单测覆盖（51 个表格用例） |

---

# 验证日志 - 2026-10-19（二）标签体系 + 块引用锚点 + 切换器排序

## 本轮改动

**标签体系（对标 Obsidian 标签面板 + 标签补全）**
1. 后端新增 `list_tags` 命令：全库扫描 .md，合并行内 `#tag` 与 frontmatter `tags:`，按引用次数降序返回 `{tag, count, files}`；大 vault（数千笔记）走 `spawn_blocking` 不阻塞 IPC 线程
2. 编辑器 `#tag` 自动补全（CM6 completion source，与 wikilink 补全并列）：`#`+字符触发，子串匹配全库标签（含嵌套 `a/b`），apply 带尾随空格；前置字符校验排除 `[[链接#锚点]]`、`## 标题`、URL 锚点
3. 侧栏新增「标签」页签（TagPanel）：按引用数排序、搜索过滤、点击展开文件列表跳转、手动刷新；打开 vault 立即建索引，保存后 3s 防抖重建

**块引用 / 标题锚点跳转**
4. 新增纯函数 `findAnchorPos`：`^block-id` 定位行尾标记所在行，标题按 ATX 文本完全匹配（忽略大小写与闭合 `#`）
5. `[[笔记#标题]]` / `[[笔记#^block-id]]` 打开文件后滚动定位（编辑器居中）；同笔记 `[[#标题]]` 直接跳转；找不到时状态栏提示不盲跳

**快速切换器 / 命令面板排序**
6. 新增 `scoreMatch` / `rankCandidates` 工具：basename 精确 > 前缀 > 路径前缀 > 子串 > 跳字；最近使用加权（localStorage `nf-recent-files` / `nf-recent-commands` 各 30 条，同分时 recent 决胜但不能逆转匹配质量差距）；空查询时快速切换器按最近打开排序（Obsidian 行为）
7. 曾考虑拼音首字母匹配：无词库时多音字错误率高，决定不支持（已在 matchScore.ts 注释记录）

## 验证结果

| 检查项 | 结果 |
|--------|------|
| 前端全量测试 | ✅ 376 passed（+26：anchor 6、tagCompletion 7、matchScore 9、TagPanel 4） |
| tsc + vite build | ✅ built in 2.20s |
| Rust 编译 | ✅ cargo build -p noteforge（async list_tags 显式 touch 后 7.16s 全量编译通过） |
| Tauri 桌面启动 | ✅ /home/wang/wk/wk（2930 笔记）打开正常，侧栏三页签（文件/大纲/标签）渲染，打开笔记与表格渲染无回归（spectacle 截屏） |
| 已知限制 | Wayland 无 xdotool/ydotool/wtype，无法脚本化点击「标签」页签；面板交互由 4 个组件级单测覆盖 |
