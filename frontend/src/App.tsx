import { useReducer, useCallback, useState, useEffect, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { layoutReducer, createInitialState } from "./layout/LayoutState";
import StatusBar from "./components/StatusBar";
import FileTree from "./components/FileTree";
import EditorPane from "./components/EditorPane";
import type { ViewMode } from "./components/EditorPane";
import AboutDialog from "./components/AboutDialog";
import SettingsDialog from "./components/SettingsDialog";
import OutlinePanel from "./components/OutlinePanel";
import { pluginManager } from "./plugins/PluginManager";
import QuickSwitcher from "./components/QuickSwitcher";
import CommandPalette from "./components/CommandPalette";
import DropdownMenu from "./components/DropdownMenu";
import { editorBridge } from "./editor/bridge";
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
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const saved = localStorage.getItem('nf-view-mode');
    return (saved === "source" || saved === "preview" || saved === "split" || saved === "live") ? saved : "split";
  });
  const [htmlViewFile, setHtmlViewFile] = useState<string | null>(null);
  // ── M6：大纲 / 主题 / 定时同步 ──
  const [sidebarMode, setSidebarMode] = useState<"files" | "outline">("files");
  const [outlineItems, setOutlineItems] = useState<OutlineItem[]>([]);
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    localStorage.getItem("nf-theme") === "dark" ? "dark" : "light");
  const autoSyncTimer = useRef<ReturnType<typeof setInterval>>(undefined);

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
      dispatch({ type: 'SET_STATUS', text: `已打开: ${path} (${tree.filter(f => !f.is_dir).length} 文件)` } as any);
    } catch (e: any) { dispatch({ type: 'SET_STATUS', text: `打开失败: ${e}` } as any); }
  }, []);

  const readNote = useCallback(async (notePath: string) => {
    if (!vaultPath) { dispatch({ type: 'SET_STATUS', text: '没有打开 Vault' } as any); return; }
    dispatch({ type: 'SET_STATUS', text: `跳转: ${notePath}` } as any);
    // Resolve wikilink target to actual file path in vault
    let resolved = notePath;
    if (!resolved.endsWith(".md") && !resolved.endsWith(".html")) {
      // Search files for a matching .md file (by exact path or filename)
      const match = files.find(f =>
        f.path === resolved ||
        f.path === resolved + ".md" ||
        f.path.endsWith("/" + resolved) ||
        f.path.endsWith("/" + resolved + ".md") ||
        // Match by filename without extension (for [[Title]]-style wikilinks)
        f.path.replace(/\.md$/, "").split("/").pop() === resolved
      );
      if (match) resolved = match.path;
    }
    // If still no match, try fuzzy search
    if (!resolved.endsWith(".md") && !resolved.endsWith(".html")) {
      const withMd = resolved + ".md";
      const fuzzy = files.find(f => f.path.toLowerCase().includes(withMd.toLowerCase()) || f.path.toLowerCase().includes(resolved.toLowerCase()));
      if (fuzzy) resolved = fuzzy.path;
    }
    // .html files use the HTML viewer
    if (resolved.endsWith(".html")) {
      setHtmlViewFile(resolved);
      return;
    }
    // Other attachments (images, PDFs) - open in viewer or OS
    if (!resolved.endsWith(".md")) {
      setHtmlViewFile(resolved);
      return;
    }
    // Skip if already loaded
    if (contentCache[resolved]) {
      const c = contentCache[resolved];
      dispatch({ type: 'OPEN_FILE', path: resolved, content: c.content, html: c.html } as any);
      return;
    }
    try {
      dispatch({ type: 'SET_STATUS', text: `加载: ${resolved}` } as any);
      const note = await invoke("read_note", { notePath: resolved }) as any;
      setContentCache(c => ({ ...c, [resolved]: { content: note.content, html: note.html } }));
      dispatch({ type: 'OPEN_FILE', path: resolved, content: note.content, html: note.html } as any);
    } catch (e: any) { dispatch({ type: 'SET_STATUS', text: `读取失败: ${e}` } as any); }
  }, [vaultPath, contentCache, files]);

  const handleBrowse = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ directory: true, multiple: false });
      if (selected) openVault(selected as string);
    } catch (e) { /* manual fallback */ }
  };

  const activeFile = findActivePath(state.main);
  const activeGroup = (() => {
    const find = (n: any): any => {
      if (n?.tabs?.length > 0) return n;
      if (n?.children) for (const c of n.children) { const r = find(c); if (r) return r; }
      return null;
    };
    return find(state.main);
  })();
  const cache = activeFile ? contentCache[activeFile] : null;
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

  const reopenVault = useCallback(async () => {
    if (!vaultPath) return;
    try {
      dispatch({ type: 'SET_STATUS', text: '重新加载...' } as any);
      const tree: FileEntry[] = await invoke("get_file_tree", {});
      setFiles(tree);
      dispatch({ type: 'SET_STATUS', text: `已刷新: ${vaultPath}` } as any);
    } catch (e: any) { dispatch({ type: 'SET_STATUS', text: `刷新失败: ${e}` } as any); }
  }, [vaultPath]);

  const vaultStats = useCallback(async () => {
    try { const s: any = await invoke("vault_stats", {}); dispatch({ type: 'SET_STATUS', text: s } as any); } catch(e: any) { dispatch({ type: 'SET_STATUS', text: `失败: ${e}` } as any); }
  }, []);

  const fileMenu = [
    { label: "打开 Vault", shortcut: "Ctrl+O", action: () => handleBrowse() },
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
    { label: "打开 Vault", shortcut: "Ctrl+O", action: () => handleBrowse() },
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

  const commands = useMemo(() => {
    const cmds = [
      { id: 'open-vault', name: '打开 Vault', shortcut: 'Ctrl+O', action: () => handleBrowse() },
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
    return cmds;
  }, [handleBrowse, vaultStats, newNote, saveNote]);

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
          onClick={() => dispatch({ type: 'SET_STATUS', text: `NoteForge v0.1.0` } as any)}>ℹ️</span>
      </div>

      {/* ── 工具栏 ── */}
      <div style={{ display: "flex", alignItems: "center", height: 40, background: "#fafafa",
        borderBottom: "1px solid #e0e0e0", padding: "0 8px", gap: 2 }}>
        <button style={btnBase} onClick={() => handleBrowse()} title="打开 Vault (Ctrl+O)">📂</button>
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
            </div>
            {sidebarMode === "files"
              ? <FileTree files={files} activeFile={activeFile || ""} onSelect={readNote} />
              : <OutlinePanel items={outlineItems} dark={theme === "dark"} />}
          </div>
        )}
        <EditorPane content={cache?.content || ""} previewHtml={cache?.html || ""}
          activeFile={activeFile || ""} files={files} onNavigate={readNote}
          theme={theme}
          onOutline={setOutlineItems}
          mode={viewMode} onSetMode={(m) => { setViewMode(m); localStorage.setItem('nf-view-mode', m); }}
          onStatus={(msg) => dispatch({ type: 'SET_STATUS', text: msg } as any)}
          onContentChange={(newContent) => {
            if (activeFile) {
              const re = invoke("render_markdown", { content: newContent }) as any;
              re.then((html: string) => {
                setContentCache(c => ({ ...c, [activeFile]: { content: newContent, html } }));
              }).catch(() => {
                setContentCache(c => ({ ...c, [activeFile]: { content: newContent, html: cache?.html || "" } }));
              });
            }
          }} />
        {htmlViewFile && (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div style={{ padding: "4px 12px", background: "#f8f8f8", borderBottom: "1px solid #ddd", fontSize: 13, color: "#666", display: "flex", alignItems: "center", gap: 8 }}>
              <span>{htmlViewFile.match(/\.(png|jpg|jpeg|gif|svg|webp)$/i) ? "🖼" : "🌐"}</span>
              <span style={{ flex: 1 }}>{htmlViewFile}</span>
              <button onClick={() => setHtmlViewFile(null)}
                style={{ padding: "2px 8px", border: "none", borderRadius: 3, cursor: "pointer", background: "transparent", color: "#999", fontSize: 16 }}>✕</button>
            </div>
            {htmlViewFile.match(/\.(png|jpg|jpeg|gif|svg|webp)$/i) ? (
              <ImageViewer filePath={htmlViewFile} />
            ) : (
              <div ref={(el) => { if (el && htmlViewFile) { const view = pluginManager.getViews().find(v => v.type === "html-effectiveness-view"); if (view) { el.innerHTML = ""; view.render(el, htmlViewFile); } } }}
                style={{ flex: 1, overflow: "hidden" }} />
            )}
          </div>
        )}
      </div>

      {/* ── 状态栏 ── */}
      <StatusBar text={(state as any).statusText || "就绪"} />

      {showQuickSwitcher && files.length > 0 && (
        <QuickSwitcher files={files} onSelect={(p) => { readNote(p); setShowQuickSwitcher(false); }}
          onClose={() => setShowQuickSwitcher(false)} />
      )}
      {showCommandPalette && (
        <CommandPalette commands={commands} onClose={() => setShowCommandPalette(false)} />
      )}
      <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} onVaultReopen={reopenVault}
        onSyncStatus={(msg) => dispatch({ type: 'SET_STATUS', text: msg } as any)} />
    </div>
  );
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
