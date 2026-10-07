import { useReducer, useCallback, useState, useEffect, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { layoutReducer, createInitialState } from "./layout/LayoutState";
import StatusBar from "./components/StatusBar";
import FileTree from "./components/FileTree";
import EditorPane from "./components/EditorPane";
import type { ViewMode } from "./components/EditorPane";
import { resolveWikilink, splitWikilink } from "./editor/wikilink";
import AboutDialog from "./components/AboutDialog";
import SettingsDialog from "./components/SettingsDialog";
import PluginPanel from "./components/PluginPanel";
import PluginSettings from "./components/PluginSettings";
import PluginSettingDialog from "./components/PluginSettingDialog";
import { obsidianRuntime } from "./plugins/obsidianRuntime";
import OutlinePanel from "./components/OutlinePanel";
import { pluginManager } from "./plugins/PluginManager";
import QuickSwitcher from "./components/QuickSwitcher";
import CommandPalette from "./components/CommandPalette";
import DropdownMenu from "./components/DropdownMenu";
import { editorBridge } from "./editor/bridge";
import { appVersion } from "./version";
import type { OutlineItem } from "./editor/bridge";

export interface FileEntry { path: string; is_dir: boolean; size: number; modified: number; }

const btnBase: React.CSSProperties = {
  padding: "5px 10px", border: "none", borderRadius: 4, cursor: "pointer",
  fontSize: 13, background: "transparent", color: "#555",
  display: "flex", alignItems: "center", gap: 4,
};


function App() {
  const [state, dispatch] = useReducer(layoutReducer, null, createInitialState);
  const [vaultPath, setVaultPath] = useState(() => localStorage.getItem('nf-last-vault') || "");
  const [initialized, setInitialized] = useState(false);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [contentCache, setContentCache] = useState<Record<string, {content:string;html:string}>>({});
  const [showQuickSwitcher, setShowQuickSwitcher] = useState(false);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pluginSettingsOpen, setPluginSettingsOpen] = useState(false);
  // 打开某个插件自己的设置页（插件注册了 PluginSettingTab 时才有内容）
  const [pluginSettingFor, setPluginSettingFor] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const saved = localStorage.getItem('nf-view-mode');
    return (saved === "source" || saved === "preview" || saved === "split" || saved === "live") ? saved : "split";
  });
  // HTML 只是与源码并列的一种显示格式，独立记忆其选择
  const [htmlMode, setHtmlMode] = useState<ViewMode>(
    () => (localStorage.getItem('nf-html-mode') === 'source' ? 'source' : 'html'));
  const [htmlViewFile, setHtmlViewFile] = useState<string | null>(null);
  // ── M6：大纲 / 主题 / 定时同步 ──
  const [sidebarMode, setSidebarMode] = useState<"files" | "outline" | "plugins">("files");
  const [outlineItems, setOutlineItems] = useState<OutlineItem[]>([]);
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    localStorage.getItem("nf-theme") === "dark" ? "dark" : "light");
  // 插件的内置命令（editor:save-file / editor:toggle-source 等）要回调宿主动作。
  // 用 ref 中转：既避开闭包过期，又能让声明留在组件顶部（顶层赋值要求先声明）。
  const saveNoteRef = useRef<(() => void) | null>(null);
  const handleSetViewModeRef = useRef<((m: "source" | "preview" | "live") => void) | null>(null);
  const autoSyncTimer = useRef<ReturnType<typeof setInterval>>(undefined);
  const renderTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // 主题：document 属性 + 持久化（CSS 由此切换亮暗）
  useEffect(() => {
    document.documentElement.setAttribute("data-nf-theme", theme);
    localStorage.setItem("nf-theme", theme);
  }, [theme]);

  // 定时自动同步：读取 sync-config 的 auto_sync_minutes，vault 打开后生效
  useEffect(() => {
    if (autoSyncTimer.current) { clearInterval(autoSyncTimer.current); autoSyncTimer.current = undefined; }
    if (!vaultPath) return;
    let minutes = 0;
    invoke<any>("sync_get_config").then((cfg) => {
      minutes = cfg?.auto_sync_minutes || 0;
      if (minutes > 0) {
        autoSyncTimer.current = setInterval(() => {
          invoke("sync_start", { firstPolicy: null })
            .then((r: any) => dispatch({ type: 'SET_STATUS', text: `☁ ${r?.uploaded ?? 0}↑ ${r?.downloaded ?? 0}↓ 冲突 ${r?.conflicts ?? 0}` } as any))
            .catch((e: any) => dispatch({ type: 'SET_STATUS', text: `☁ 自动同步失败: ${e}` } as any));
        }, minutes * 60 * 1000);
      }
      // 启动时同步（vault 打开后触发一次）
      if (cfg?.sync_on_startup) {
        invoke("sync_start", { firstPolicy: null })
          .then((r: any) => dispatch({ type: 'SET_STATUS', text: `☁ 启动同步：${r?.uploaded ?? 0}↑ ${r?.downloaded ?? 0}↓` } as any))
          .catch(() => {});
      }
    }).catch(() => {});
    return () => { if (autoSyncTimer.current) { clearInterval(autoSyncTimer.current); autoSyncTimer.current = undefined; } };
  }, [vaultPath, settingsOpen]);

  // Auto-open last vault on startup
  useEffect(() => {
    if (!initialized) {
      setInitialized(true);
      const last = localStorage.getItem('nf-last-vault');
      if (last) openVault(last);
    }
  }, [initialized]);

  const openVault = useCallback(async (path: string) => {
    try {
      dispatch({ type: 'SET_STATUS', text: '正在打开...' } as any);
      const tree: FileEntry[] = await invoke("open_vault", { path });
      setVaultPath(path); setFiles(tree);
      localStorage.setItem('nf-last-vault', path);
      // Load plugins
      pluginManager.loadPlugins(path);
      // Obsidian 兼容插件：加载 .obsidian/plugins 下已启用的插件
      void obsidianRuntime.init({
        vaultPath: () => path,
        // 插件视图打开的文件不在编辑器里，宿主活动文件会为空 —— 用运行时的兜底值
        activeFile: () => activeFileRef.current ?? obsidianRuntime.activeFileFallback(),
        openFile: async (p: string) => { await readNoteRef.current?.(p); },
        saveFile: () => saveNoteRef.current?.(),
        toggleMode: (m) => handleSetViewModeRef.current?.(m),
        openSettings: () => setSettingsOpen(true),
        openPluginSettings: (id: string) => setPluginSettingFor(id),
        // 插件视图统一挂到运行时自持的右侧停靠面板（noteforge 没有 Obsidian 的右侧栏）
        ensureViewContainer: async (type: string) => obsidianRuntime.containerFor(type),
      }).catch((e) => console.warn("[plugin] 加载失败", e));
      dispatch({ type: 'SET_STATUS', text: `已打开: ${path} (${tree.filter(f => !f.is_dir).length} 文件)` } as any);
    } catch (e: any) { dispatch({ type: 'SET_STATUS', text: `打开失败: ${e}` } as any); }
  }, []);

  const readNote = useCallback(async (notePath: string) => {
    if (!vaultPath) { dispatch({ type: 'SET_STATUS', text: '没有打开 Vault' } as any); return; }
    // 统一 wikilink 解析：完整路径 → 路径后缀 → 文件名（忽略大小写）→ 唯一模糊；
    // 别名/锚点不参与匹配，歧义时不再盲跳到某个文件。
    const hasExt = /\.(md|markdown|html?)$/i.test(notePath);
    const hit = hasExt
      ? { path: notePath }
      : resolveWikilink(notePath, files as unknown as { path: string; is_dir?: boolean }[]);
    if (!hit.path) {
      const { target } = splitWikilink(notePath);
      dispatch({
        type: 'SET_STATUS',
        text: hit.ambiguous
          ? `⚠ 链接「${target}」有多个同名文件，请写完整路径`
          : `❌ 未找到链接目标: ${target}`,
      } as any);
      return;
    }
    const resolved = hit.path;
    if (hit.ambiguous && hit.ambiguous.length > 1) {
      dispatch({ type: 'SET_STATUS', text: `跳转: ${resolved}（同名 ${hit.ambiguous.length} 个，取最浅路径）` } as any);
    } else {
      dispatch({ type: 'SET_STATUS', text: `跳转: ${resolved}` } as any);
    }
    // 插件用 registerExtensions 声明接管的自定义扩展名（如 quadrant-chart 的 .mdx）
    // 要走插件自己的视图，否则只会看到一坨 YAML/二进制。
    const dot = resolved.lastIndexOf(".");
    const ext = dot > 0 ? resolved.slice(dot + 1).toLowerCase() : "";
    if (ext) {
      const viewType = obsidianRuntime.viewTypeForExtension(ext);
      if (viewType) {
        dispatch({ type: 'SET_STATUS', text: `打开: ${resolved}（${viewType} 视图）` } as any);
        await obsidianRuntime.openView(viewType, { file: resolved });
        obsidianRuntime.notifyFileOpen(resolved);
        return;
      }
    }
    // .html 作为普通文件走编辑器（源码/HTML 两种并列格式在 EditorPane 内切换）
    // 其他附件（图片、PDF）仍走独立查看面板
    if (!resolved.endsWith(".md") && !/\.html?$/i.test(resolved)) {
      setHtmlViewFile(resolved);
      obsidianRuntime.notifyFileOpen(resolved);
      return;
    }
    // Skip if already loaded
    if (contentCache[resolved]) {
      const c = contentCache[resolved];
      dispatch({ type: 'OPEN_FILE', path: resolved, content: c.content, html: c.html } as any);
      obsidianRuntime.notifyFileOpen(resolved);
      return;
    }
    try {
      dispatch({ type: 'SET_STATUS', text: `加载: ${resolved}` } as any);
      const note = await invoke("read_note", { notePath: resolved }) as any;
      setContentCache(c => ({ ...c, [resolved]: { content: note.content, html: note.html } }));
      dispatch({ type: 'OPEN_FILE', path: resolved, content: note.content, html: note.html } as any);
      obsidianRuntime.notifyFileOpen(resolved);
    } catch (e: any) { dispatch({ type: 'SET_STATUS', text: `读取失败: ${e}` } as any); }
  }, [vaultPath, contentCache, files]);

  const handleBrowse = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ directory: true, multiple: false });
  readNoteRef.current = readNote;
      if (selected) openVault(selected as string);
    } catch (e) { /* manual fallback */ }
  };

  const activeFile = findActivePath(state.main);
  // HTML 是与源码并列的显示格式，不占独立 block
  const htmlActive = !!activeFile && /\.html?$/i.test(activeFile);
  const paneMode: ViewMode = htmlActive ? htmlMode : viewMode;
  const handleSetMode = (m: ViewMode) => {
    if (htmlActive) {
      const next = m === "html" ? "html" : "source";
      setHtmlMode(next);
      localStorage.setItem('nf-html-mode', next);
    } else {
      setViewMode(m);
      localStorage.setItem('nf-view-mode', m);
    }
  };
  handleSetViewModeRef.current = (m) => handleSetMode(m);
  const activeGroup = (() => {
    const find = (n: any): any => {
      if (n?.tabs?.length > 0) return n;
      if (n?.children) for (const c of n.children) { const r = find(c); if (r) return r; }
      return null;
    };
    return find(state.main);
  })();
  const cache = activeFile ? contentCache[activeFile] : null;

  // ── 外部文件变更：本地磁盘改动后自动刷新显示内容 ──────────────────
  // 只在「编辑器无未保存修改」时覆盖，避免冲掉用户正在输入的内容。
  const lastStampRef = useRef<Record<string, string>>({});
  const treeSigRef = useRef("");
  useEffect(() => {
    if (!vaultPath) return;
    let stopped = false;

    const pollNote = async () => {
      if (stopped) return;
      const file = activeFile;
      if (!file) return;
      try {
        const stamp = await invoke<{ mtime_ms: number; size: number }>("stat_note", { notePath: file });
        const key = `${stamp.mtime_ms}:${stamp.size}`;
        const last = lastStampRef.current[file];
        lastStampRef.current[file] = key;
        if (!last || last === key) return;
        // 磁盘已变：先看编辑器有没有未保存修改
        if (editorBridge.isDirty?.()) {
          dispatch({ type: 'SET_STATUS', text: `⚠ ${file} 已在磁盘更新（当前有未保存修改，保存后生效）` } as any);
          return;
        }
        const note = await invoke<any>("read_note", { notePath: file });
        if (stopped) return;
        setContentCache(c => ({ ...c, [file]: { content: note.content, html: note.html } }));
        dispatch({ type: 'OPEN_FILE', path: file, content: note.content, html: note.html } as any);
        dispatch({ type: 'SET_STATUS', text: `🔄 已从磁盘刷新: ${file}` } as any);
      } catch {
        /* 文件可能被删除或暂时不可读，忽略 */
      }
    };

    const pollTree = async () => {
      if (stopped) return;
      try {
        const tree = await invoke<FileEntry[]>("get_file_tree", {});
        if (stopped) return;
        const sig = tree.map(f => f.path).join("\u0001");
        if (sig === treeSigRef.current) return;
        treeSigRef.current = sig;
        setFiles(tree);
      } catch { /* ignore */ }
    };

    const noteTimer = setInterval(pollNote, 3000);
    const treeTimer = setInterval(pollTree, 15000);
    void pollTree();
    return () => {
      stopped = true;
      clearInterval(noteTimer);
      clearInterval(treeTimer);
    };
  }, [vaultPath, activeFile]);

  const noteCount = files.filter(f => !f.is_dir).length;

  // ── Menu actions (stable references) ──────────────────────────────
  const newNote = useCallback(async () => {
    if (!vaultPath) { dispatch({ type: 'SET_STATUS', text: '请先打开 Vault' } as any); return; }
    const name = prompt('笔记名称:', 'new-note.md');
    if (!name) return;
    try {
      await invoke("create_note", { notePath: name });
      const tree: any[] = await invoke("get_file_tree", {});
      setFiles(tree as FileEntry[]);
      dispatch({ type: 'SET_STATUS', text: `已创建: ${name}` } as any);
    } catch(e: any) { dispatch({ type: 'SET_STATUS', text: `创建失败: ${e}` } as any); }
  }, [vaultPath]);

  const saveNote = useCallback(async () => {
    if (!vaultPath || !activeFile) { dispatch({ type: 'SET_STATUS', text: '没有需要保存的文件' } as any); return; }
    // 优先走编辑器自身保存（最新文档 + 原子写 + 脏标记），避免缓存滞后丢字
    if (editorBridge.requestSave && editorBridge.activeFile === activeFile) {
      editorBridge.requestSave();
      return;
    }
    try {
      await invoke("write_note", { notePath: activeFile, content: cache?.content ?? editorBridge.latestDoc ?? "" });
      dispatch({ type: 'SET_STATUS', text: `已保存: ${activeFile}` } as any);
    } catch(e: any) { dispatch({ type: 'SET_STATUS', text: `保存失败: ${e}` } as any); }
  }, [vaultPath, activeFile, cache]);

  // ── 全局快捷键：Ctrl+O 快速切换 / Ctrl+P 命令面板 / Ctrl+S 保存 / Ctrl+N 新建 ──
  // （与菜单标注及 Obsidian 习惯一致；编辑器已处理的按键让其自行 preventDefault）
  const newNoteRef = useRef(newNote);
  // 插件运行时需要在 openVault 时就拿到「打开文件」能力，而 readNote 定义在其后 —— 用 ref 中转
  const readNoteRef = useRef<((p: string) => Promise<void>) | null>(null);
  const activeFileRef = useRef<string | null>(null);
  activeFileRef.current = activeFile;
  newNoteRef.current = newNote;
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.defaultPrevented) return;
      const k = e.key.toLowerCase();
      if (k === "o") { e.preventDefault(); setShowQuickSwitcher(true); }
      else if (k === "p") { e.preventDefault(); setShowCommandPalette(true); }
      else if (k === "s") { e.preventDefault(); editorBridge.requestSave?.(); }
      else if (k === "n") { e.preventDefault(); newNoteRef.current(); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const reopenVault = useCallback(async () => {
    if (!vaultPath) return;
    try {
      dispatch({ type: 'SET_STATUS', text: '重新加载...' } as any);
      const tree: FileEntry[] = await invoke("get_file_tree", {});
      treeSigRef.current = tree.map(f => f.path).join("\u0001");
      setFiles(tree);
      dispatch({ type: 'SET_STATUS', text: `已刷新: ${vaultPath}` } as any);
    } catch (e: any) { dispatch({ type: 'SET_STATUS', text: `刷新失败: ${e}` } as any); }
  }, [vaultPath]);

  const vaultStats = useCallback(async () => {
    try { const s: any = await invoke("vault_stats", {}); dispatch({ type: 'SET_STATUS', text: s } as any); } catch(e: any) { dispatch({ type: 'SET_STATUS', text: `失败: ${e}` } as any); }
  }, []);

  const fileMenu = [
    { label: "打开 Vault", action: () => handleBrowse() },
    { label: "新建笔记", shortcut: "Ctrl+N", action: newNote },
    { divider: true as const },
    { label: "保存", shortcut: "Ctrl+S", action: saveNote },
    { divider: true as const },
    { label: "导出为 PDF", disabled: true as const },
    { label: "导出为 HTML", disabled: true as const },
    { divider: true as const },
    { label: "退出", shortcut: "Alt+F4", action: () => { getCurrentWindow().close(); } },
  ];

  const editMenu = [
    { label: "撤销", shortcut: "Ctrl+Z", disabled: true as const },
    { label: "重做", shortcut: "Ctrl+Y", disabled: true as const },
    { divider: true as const },
    { label: "剪切", shortcut: "Ctrl+X", disabled: true as const },
    { label: "复制", shortcut: "Ctrl+C" },
    { label: "粘贴", shortcut: "Ctrl+V", disabled: true as const },
    { divider: true as const },
    { label: "查找", shortcut: "Ctrl+F", disabled: true as const },
    { label: "替换", shortcut: "Ctrl+H", disabled: true as const },
  ];

  const viewMenu = [
    { label: "切换侧栏", action: () => setSidebarVisible(s => !s) },
    { label: "侧栏：文件", action: () => { setSidebarVisible(true); setSidebarMode("files"); } },
    { label: "侧栏：大纲", action: () => { setSidebarVisible(true); setSidebarMode("outline"); } },
    { divider: true as const },
    { label: theme === "dark" ? "☀ 切换亮色主题" : "🌙 切换暗色主题", action: () => setTheme(t => t === "dark" ? "light" : "dark") },
    { divider: true as const },
    { label: "源码模式", action: () => setViewMode("source") },
    { label: "分栏模式", action: () => setViewMode("split") },
    { label: "即输即显", action: () => setViewMode("live") },
    { label: "预览模式", action: () => setViewMode("preview") },
    { divider: true as const },
    { label: "快速切换器", shortcut: "Ctrl+O", action: () => setShowQuickSwitcher(true) },
    { label: "命令面板", shortcut: "Ctrl+P", action: () => setShowCommandPalette(true) },
    { divider: true as const },
    { label: "图谱视图", disabled: true as const },
  ];

  const toolsMenu = [
    { label: "设置", action: () => setSettingsOpen(true) },
    { label: "生成测试库", action: async () => {
      if (!vaultPath) { dispatch({ type: 'SET_STATUS', text: '请先打开 Vault' } as any); return; }
      const profile = prompt('测试库 profile (smoke/stress/crosslink/topo-complex):', 'smoke');
      if (profile) {
        try {
          const seed = Date.now();
          const out = prompt('输出路径:', `${vaultPath}_test`);
          if (out) {
            const result: any = await invoke("generate_vault", { profile, seed, out });
            dispatch({ type: 'SET_STATUS', text: result } as any);
          }
        } catch(e: any) { dispatch({ type: 'SET_STATUS', text: `生成失败: ${e}` } as any); }
      }
    } },
    { label: "检查链接", disabled: true as const },
    { label: "Vault 统计", action: vaultStats },
  ];

  const helpMenu = [
    { label: "关于 NoteForge", action: () => setAboutOpen(true) },
    { label: "版本信息", action: () => setAboutOpen(true) },
  ];

  const quickActions = [
    { label: "打开 Vault", action: () => handleBrowse() },
    { label: "新建笔记", shortcut: "Ctrl+N", action: newNote },
    { divider: true as const },
    { label: "保存", shortcut: "Ctrl+S", action: saveNote },
    { divider: true as const },
    { label: "切换侧栏", action: () => setSidebarVisible(s => !s) },
    { label: "快速切换", shortcut: "Ctrl+O", action: () => setShowQuickSwitcher(true) },
    { label: "命令面板", shortcut: "Ctrl+P", action: () => setShowCommandPalette(true) },
    { divider: true as const },
    { label: "Vault 统计", action: vaultStats },
  ];

  // 插件是异步加载的：订阅运行时，否则命令面板的 useMemo 拿不到后注册的插件命令
  const [pluginTick, setPluginTick] = useState(0);
  useEffect(() => obsidianRuntime.subscribe(() => setPluginTick((n) => n + 1)), []);
  // 插件接管的扩展名（如 quadrant-chart 的 .mdx）—— 文件树与快速切换器要放它们进来，
  // 否则这些文件在 UI 里根本不存在。依赖 pluginTick：插件启停/安装后自动重算。
  const pluginExts = useMemo(
    () => obsidianRuntime.registeredExtensions(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pluginTick],
  );

  const commands = useMemo(() => {
    const cmds = [
      { id: 'open-vault', name: '打开 Vault', action: () => handleBrowse() },
      { id: 'quick-switcher', name: '快速切换器', shortcut: 'Ctrl+O', action: () => setShowQuickSwitcher(true) },
      { id: 'command-palette', name: '命令面板', shortcut: 'Ctrl+P', action: () => setShowCommandPalette(true) },
      { id: 'toggle-sidebar', name: '切换侧栏', action: () => setSidebarVisible(s => !s) },
      { id: 'vault-stats', name: 'Vault 统计', action: vaultStats },
      { id: 'new-note', name: '新建笔记', action: newNote },
    ];
    // Plugin commands
    for (const pc of pluginManager.getCommands()) {
      cmds.push({ id: `plugin-${pc.id}`, name: pc.name, action: pc.callback });
    }
    // Obsidian 兼容插件命令
    for (const oc of obsidianRuntime.commands()) {
      cmds.push({ id: `obsidian-plugin-${oc.id}`, name: oc.name, action: oc.run });
    }
    return cmds;
  }, [handleBrowse, vaultStats, newNote, saveNote, pluginTick]);

  return (
    <div data-nf-dark={theme === "dark"} style={{ display: "flex", flexDirection: "column", height: "100vh",
      background: theme === "dark" ? "#1e1e1e" : "#fff", colorScheme: theme }}>
      <style>{`
        [data-nf-dark="true"] > div:nth-of-type(1) { background: #252526 !important; border-color: #333 !important; }
        [data-nf-dark="true"] > div:nth-of-type(1) span, [data-nf-dark="true"] > div:nth-of-type(1) button { color: #c8c8c8 !important; }
        [data-nf-dark="true"] > div:nth-of-type(2) { background: #2d2d2d !important; border-color: #333 !important; }
        [data-nf-dark="true"] .nf-status { background: #252526 !important; color: #9a9a9a !important; border-color: #333 !important; }
        [data-nf-dark="true"] .markdown-body { color: #d4d4d4; }
        [data-nf-dark="true"] .markdown-body a[data-note] { color: #6cb2ff; background: #1c3a5e; }
        [data-nf-dark="true"] .markdown-body code { background: #2d2d30; color: #f0a5a5; }
        [data-nf-dark="true"] .markdown-body pre { background: #252526; }
        [data-nf-dark="true"] .markdown-body blockquote { color: #a0a0a0; border-color: #3c3c3c; }
        [data-nf-dark="true"] .markdown-body table th, [data-nf-dark="true"] .markdown-body table td { border-color: #444; }
      `}</style>
      {/* ── 菜单栏 ── */}
      <div style={{ display: "flex", alignItems: "center", height: 32, background: "#f5f5f5",
        borderBottom: "1px solid #e0e0e0", padding: "0 8px", gap: 2, fontSize: 13, userSelect: "none" }}>
        <span style={{ fontWeight: 700, color: "#333", marginRight: 12, fontSize: 14 }}>NoteForge</span>
        <DropdownMenu label="文件" items={fileMenu} />
        <DropdownMenu label="编辑" items={editMenu} />
        <DropdownMenu label="视图" items={viewMenu} />
        <DropdownMenu label="工具" items={toolsMenu} />
        <DropdownMenu label="帮助" items={helpMenu} />
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: "#999", cursor: "pointer" }}
          onClick={() => { void appVersion().then(v => dispatch({ type: 'SET_STATUS', text: `NoteForge v${v}` } as any)); }}>ℹ️</span>
      </div>

      {/* ── 工具栏 ── */}
      <div style={{ display: "flex", alignItems: "center", height: 40, background: "#fafafa",
        borderBottom: "1px solid #e0e0e0", padding: "0 8px", gap: 2 }}>
        <button style={btnBase} onClick={() => handleBrowse()} title="打开 Vault">📂</button>
        <button style={btnBase} onClick={newNote} title="新建笔记">📄</button>
        <button style={btnBase} onClick={saveNote} title="保存 (Ctrl+S)">💾</button>
        <button style={btnBase} onClick={() => {
          if (activeGroup && activeGroup.tabs.length > 1) {
            const prev = activeGroup.activeIndex > 0 ? activeGroup.activeIndex - 1 : 0;
            if (prev !== activeGroup.activeIndex) {
              dispatch({ type: 'SELECT_TAB', groupId: activeGroup.id, tabId: activeGroup.tabs[prev].id } as any);
            }
          }
        }} title="返回上一页">←</button>
        <div style={{ width: 1, height: 20, background: "#e0e0e0", margin: "0 4px" }} />
        <button style={btnBase} onClick={() => setShowQuickSwitcher(true)} title="快速切换 (Ctrl+O)">🔍</button>
        <button style={btnBase} onClick={() => setShowCommandPalette(true)} title="命令面板 (Ctrl+P)">⌘</button>
        <div style={{ width: 1, height: 20, background: "#e0e0e0", margin: "0 4px" }} />
        <button style={btnBase} onClick={() => setSidebarVisible(s => !s)} title="切换侧栏">📁</button>
        <DropdownMenu label="..." items={quickActions} />
        <div style={{ flex: 1 }} />
        {vaultPath && <span style={{ fontSize: 12, color: "#999", marginRight: 8 }}>{noteCount} 篇笔记</span>}
        {activeFile && <span style={{ fontSize: 12, color: "#999" }}>{activeFile}</span>}
      </div>

      {/* ── 主区域 ── */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {sidebarVisible && files.length > 0 && (
          <div className="nf-sidebar" style={{ width: 260, minWidth: 200, background: theme === "dark" ? "#252526" : "#fafafa", borderRight: "1px solid #e0e0e0", display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", borderBottom: "1px solid #eee" }}>
              <button onClick={() => setSidebarMode("files")}
                style={{ flex: 1, padding: "8px 0", border: "none", cursor: "pointer", fontSize: 13, fontWeight: 600,
                  background: sidebarMode === "files" ? (theme === "dark" ? "#333" : "#fff") : "transparent",
                  color: theme === "dark" ? "#ccc" : "#555" }}>
                📁 文件
              </button>
              <button onClick={() => setSidebarMode("outline")}
                style={{ flex: 1, padding: "8px 0", border: "none", cursor: "pointer", fontSize: 13, fontWeight: 600,
                  background: sidebarMode === "outline" ? (theme === "dark" ? "#333" : "#fff") : "transparent",
                  color: theme === "dark" ? "#ccc" : "#555" }}>
                📑 大纲
              </button>
              <button onClick={() => setSidebarMode("plugins")}
                style={{ flex: 1, padding: "8px 0", border: "none", cursor: "pointer", fontSize: 13, fontWeight: 600,
                  background: sidebarMode === "plugins" ? (theme === "dark" ? "#333" : "#fff") : "transparent",
                  color: theme === "dark" ? "#ccc" : "#555" }}>
                🧩 插件
              </button>
            </div>
            {sidebarMode === "files"
              ? <FileTree key={vaultPath} files={files} activeFile={activeFile || ""} onSelect={readNote} vaultPath={vaultPath} extraExts={pluginExts} />
              : sidebarMode === "outline"
                ? <OutlinePanel items={outlineItems} dark={theme === "dark"} />
                : <PluginPanel dark={theme === "dark"} onOpenSettings={() => setPluginSettingsOpen(true)} onRefresh={() => void obsidianRuntime.reload()} onOpenPluginSettings={(id) => setPluginSettingFor(id)} />}
          </div>
        )}
        <EditorPane content={cache?.content || ""} previewHtml={cache?.html || ""}
          activeFile={activeFile || ""} files={files} onNavigate={readNote}
          theme={theme}
          onOutline={setOutlineItems}
          htmlFile={htmlActive ? activeFile : null}
          mode={paneMode} onSetMode={handleSetMode}
          onStatus={(msg) => dispatch({ type: 'SET_STATUS', text: msg } as any)}
          onContentChange={(newContent) => {
            if (!activeFile) return;
            // 防抖 250ms：降低 render_markdown 乱序回写压力（编辑器侧另有 echo 守卫兜底）
            if (renderTimer.current) clearTimeout(renderTimer.current);
            renderTimer.current = setTimeout(() => {
              const file = activeFile;
              invoke<string>("render_markdown", { content: newContent })
                .then((html: string) => {
                  setContentCache(c => ({ ...c, [file]: { content: newContent, html } }));
                })
                .catch(() => {
                  setContentCache(c => ({ ...c, [file]: { content: newContent, html: "" } }));
                });
            }, 250);
          }} />
        {htmlViewFile && (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div style={{ padding: "0 8px", background: "#fafafa", borderBottom: "1px solid #e5e5e5", fontSize: 12, color: "#777", display: "flex", alignItems: "center", gap: 6, height: 26 }}>
              <span style={{ fontSize: 12 }}>🖼</span>
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{htmlViewFile}</span>
              <button onClick={() => setHtmlViewFile(null)}
                title="关闭"
                style={{ padding: "0 6px", border: "none", borderRadius: 3, cursor: "pointer", background: "transparent", color: "#aaa", fontSize: 13, lineHeight: "26px" }}>✕</button>
            </div>
            <ImageViewer filePath={htmlViewFile} />
          </div>
        )}
      </div>

      {/* ── 状态栏 ── */}
      <StatusBar text={(state as any).statusText || "就绪"} />

      {showQuickSwitcher && files.length > 0 && (
        <QuickSwitcher extraExts={pluginExts} files={files} onSelect={(p) => { readNote(p); setShowQuickSwitcher(false); }}
          onClose={() => setShowQuickSwitcher(false)} />
      )}
      {showCommandPalette && (
        <CommandPalette commands={commands} onClose={() => setShowCommandPalette(false)} />
      )}
      <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} />
      {pluginSettingFor && (
        <PluginSettingDialog
          pluginId={pluginSettingFor}
          dark={theme === "dark"}
          onClose={() => setPluginSettingFor(null)}
        />
      )}
      {pluginSettingsOpen && vaultPath && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.35)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 10000 }}>
          <div style={{ background: theme === "dark" ? "#252526" : "#fff", borderRadius: 8, width: "min(860px, 94vw)", height: "min(660px, 88vh)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <PluginSettings
              vaultPath={vaultPath}
              dark={theme === "dark"}
              onChanged={() => void obsidianRuntime.reload()}
              onClose={() => setPluginSettingsOpen(false)}
              onOpenPluginSettings={(id) => setPluginSettingFor(id)}
            />
          </div>
        </div>
      )}
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} onVaultReopen={reopenVault}
        onSyncStatus={(msg) => dispatch({ type: 'SET_STATUS', text: msg } as any)} />
    </div>
  );
  saveNoteRef.current = () => { void saveNote(); };
}

function findActivePath(node: any): string | null {
  if (node?.tabs && node.tabs.length > 0) return node.tabs[node.activeIndex]?.view?.path || null;
  if (node?.children) return findActivePath(node.children[0]);
  return null;
}

function ImageViewer({ filePath }: { filePath: string }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    invoke<string>("read_file_data", { path: filePath })
      .then(setDataUrl)
      .catch((e: any) => setErr(e.toString()));
  }, [filePath]);
  if (err) return <p style={{ padding: 16, color: "red" }}>加载失败: {err}</p>;
  if (!dataUrl) return <p style={{ padding: 16, color: "#999" }}>加载中...</p>;
  return (
    <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", background: "#f0f0f0", overflow: "auto" }}>
      <img src={dataUrl} alt={filePath}
        style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
    </div>
  );
}

export default App;
