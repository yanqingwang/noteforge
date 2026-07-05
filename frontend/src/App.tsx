import { useReducer, useCallback, useState, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { layoutReducer, createInitialState } from "./layout/LayoutState";
import StatusBar from "./components/StatusBar";
import FileTree from "./components/FileTree";
import EditorPane from "./components/EditorPane";
import QuickSwitcher from "./components/QuickSwitcher";
import CommandPalette from "./components/CommandPalette";
import DropdownMenu from "./components/DropdownMenu";

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
      dispatch({ type: 'SET_STATUS', text: `已打开: ${path} (${tree.filter(f => !f.is_dir).length} 文件)` } as any);
    } catch (e: any) { dispatch({ type: 'SET_STATUS', text: `打开失败: ${e}` } as any); }
  }, []);

  const readNote = useCallback(async (notePath: string) => {
    if (!vaultPath) return;
    // Skip if already loaded
    if (contentCache[notePath]) {
      const c = contentCache[notePath];
      dispatch({ type: 'OPEN_FILE', path: notePath, content: c.content, html: c.html } as any);
      return;
    }
    try {
      dispatch({ type: 'SET_STATUS', text: `加载: ${notePath}` } as any);
      const note = await invoke("read_note", { notePath }) as any;
      setContentCache(c => ({ ...c, [notePath]: { content: note.content, html: note.html } }));
      dispatch({ type: 'OPEN_FILE', path: notePath, content: note.content, html: note.html } as any);
    } catch (e: any) { dispatch({ type: 'SET_STATUS', text: `读取失败: ${e}` } as any); }
  }, [vaultPath, contentCache]);

  const handleBrowse = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ directory: true, multiple: false });
      if (selected) openVault(selected as string);
    } catch (e) { /* manual fallback */ }
  };

  const activeFile = findActivePath(state.main);
  const cache = activeFile ? contentCache[activeFile] : null;
  const noteCount = files.filter(f => !f.is_dir).length;

  // ── Menu definitions (stable references) ──────────────────────────
  const fileActions = useMemo(() => ({
    handleBrowse, readNote,
    newNote: async () => {
      if (!vaultPath) { dispatch({ type: 'SET_STATUS', text: '请先打开 Vault' } as any); return; }
      const name = prompt('笔记名称:', 'new-note.md');
      if (name) {
        try {
          await invoke("create_note", { notePath: name });
          // Refresh tree only
          const tree: any[] = await invoke("get_file_tree", {});
          setFiles(tree as FileEntry[]);
          dispatch({ type: 'SET_STATUS', text: `已创建: ${name}` } as any);
        } catch(e: any) { dispatch({ type: 'SET_STATUS', text: `创建失败: ${e}` } as any); }
      }
    },
    saveNote: async () => {
      if (!vaultPath || !activeFile || !cache) { dispatch({ type: 'SET_STATUS', text: '没有需要保存的文件' } as any); return; }
      try {
        await invoke("write_note", { notePath: activeFile, content: cache.content });
        dispatch({ type: 'SET_STATUS', text: `已保存: ${activeFile}` } as any);
      } catch(e: any) { dispatch({ type: 'SET_STATUS', text: `保存失败: ${e}` } as any); }
    },
    vaultStats: async () => {
      if (!vaultPath) return;
      try { const s: any = await invoke("vault_stats", {}); dispatch({ type: 'SET_STATUS', text: s } as any); } catch(e: any) { dispatch({ type: 'SET_STATUS', text: `失败: ${e}` } as any); }
    },
  }), [vaultPath, activeFile, cache, handleBrowse, readNote]);

  const fileMenu = [
    { label: "打开 Vault", shortcut: "Ctrl+O", action: () => handleBrowse() },
    { label: "新建笔记", shortcut: "Ctrl+N", action: fileActions.newNote },
    { divider: true as const },
    { label: "保存", shortcut: "Ctrl+S", action: fileActions.saveNote },
    { divider: true as const },
    { label: "导出为 PDF", disabled: true as const },
    { label: "导出为 HTML", disabled: true as const },
    { divider: true as const },
    { label: "退出", shortcut: "Alt+F4", action: () => window.close() },
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
    { label: "源码模式", action: () => {} },
    { label: "预览模式", action: () => {} },
    { label: "分栏模式", action: () => {} },
    { divider: true as const },
    { label: "快速切换器", shortcut: "Ctrl+O", action: () => setShowQuickSwitcher(true) },
    { label: "命令面板", shortcut: "Ctrl+P", action: () => setShowCommandPalette(true) },
    { divider: true as const },
    { label: "图谱视图", disabled: true as const },
  ];

  const toolsMenu = [
    { label: "生成测试库", action: () => { dispatch({ type: 'SET_STATUS', text: '生成功能待实现' } as any); } },
    { label: "检查链接", disabled: true as const },
    { label: "Vault 统计", action: fileActions.vaultStats },
  ];

  const helpMenu = [
    { label: "关于 NoteForge", action: () => {
    dispatch({ type: 'SET_STATUS', text: `NoteForge v0.1.0 - Tauri2 + React + TypeScript - 本地优先知识管理` } as any);
  } },
    { label: "版本信息", action: () => { dispatch({ type: 'SET_STATUS', text: `构建: 2026-07` } as any); } },
  ];

  const quickActions = [
    { label: "打开 Vault", shortcut: "Ctrl+O", action: () => handleBrowse() },
    { label: "新建笔记", shortcut: "Ctrl+N", action: fileActions.newNote },
    { divider: true as const },
    { label: "保存", shortcut: "Ctrl+S", action: fileActions.saveNote },
    { divider: true as const },
    { label: "切换侧栏", action: () => setSidebarVisible(s => !s) },
    { label: "快速切换", shortcut: "Ctrl+O", action: () => setShowQuickSwitcher(true) },
    { label: "命令面板", shortcut: "Ctrl+P", action: () => setShowCommandPalette(true) },
    { divider: true as const },
    { label: "Vault 统计", action: fileActions.vaultStats },
  ];

  const commands = useMemo(() => [
    { id: 'open-vault', name: '打开 Vault', shortcut: 'Ctrl+O', action: () => handleBrowse() },
    { id: 'quick-switcher', name: '快速切换器', shortcut: 'Ctrl+O', action: () => setShowQuickSwitcher(true) },
    { id: 'command-palette', name: '命令面板', shortcut: 'Ctrl+P', action: () => setShowCommandPalette(true) },
    { id: 'toggle-sidebar', name: '切换侧栏', action: () => setSidebarVisible(s => !s) },
    { id: 'vault-stats', name: 'Vault 统计', action: fileActions.vaultStats },
    { id: 'new-note', name: '新建笔记', action: fileActions.newNote },
  ], [handleBrowse, fileActions]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "#fff" }}>
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
        <button style={btnBase} onClick={fileActions.newNote} title="新建笔记">📄</button>
        <button style={btnBase} onClick={fileActions.saveNote} title="保存 (Ctrl+S)">💾</button>
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
          <div style={{ width: 260, minWidth: 200, background: "#fafafa", borderRight: "1px solid #e0e0e0", display: "flex", flexDirection: "column" }}>
            <div style={{ padding: "8px 12px", fontWeight: 600, fontSize: 13, color: "#555", borderBottom: "1px solid #eee" }}>
              📁 文件浏览
            </div>
            <FileTree files={files} activeFile={activeFile || ""} onSelect={readNote} />
          </div>
        )}
        <EditorPane content={cache?.content || ""} previewHtml={cache?.html || ""}
          activeFile={activeFile || ""} files={files} onNavigate={readNote} />
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
    </div>
  );
}

function findActivePath(node: any): string | null {
  if (node?.tabs && node.tabs.length > 0) return node.tabs[node.activeIndex]?.view?.path || null;
  if (node?.children) return findActivePath(node.children[0]);
  return null;
}

export default App;
