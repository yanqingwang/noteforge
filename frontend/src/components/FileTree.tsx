import { useEffect, useState, memo } from "react";
import type { FileEntry } from "../App";

type SortMode = "name-asc" | "name-desc" | "modified-desc" | "modified-asc" | "size-desc" | "size-asc";

interface FileTreeProps {
  files: FileEntry[];
  activeFile: string;
  onSelect: (path: string) => void;
  /** 当前 vault 路径，用于按 vault 持久化文件夹展开状态（缺省不持久化） */
  vaultPath?: string;
  /** 插件通过 registerExtensions 声明接管的扩展名（额外纳入文件树） */
  extraExts?: readonly string[];
}

/**
 * 树中展示的文件类型：Markdown 笔记 + HTML 报告 + **插件接管的扩展名**。
 *
 * extraExts 来自插件的 `registerExtensions(['mdx'], viewType)`（如 quadrant-chart）。
 * 不把它们算进来，.mdx 这类文件在文件树和快速切换器里直接消失 ——
 * 用户根本没法打开它们，功能等于没做。
 */
export function isRenderableFile(path: string, extraExts: readonly string[] = []): boolean {
  if (/\.(?:md|html?)$/i.test(path)) return true;
  if (!extraExts.length) return false;
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  const ext = path.slice(dot + 1).toLowerCase();
  return extraExts.some((e) => String(e).replace(/^\./, "").toLowerCase() === ext);
}

/** 收集一个文件路径的全部祖先目录（vault 相对路径） */
export function ancestorDirs(path: string): string[] {
  const parts = path.split("/");
  parts.pop();
  const dirs: string[] = [];
  let acc = "";
  for (const p of parts) {
    acc = acc ? `${acc}/${p}` : p;
    dirs.push(acc);
  }
  return dirs;
}

const storageKey = (vaultPath?: string) => (vaultPath ? `nf-expanded:${vaultPath}` : "");

const FileTree = memo(function FileTree({ files, activeFile, onSelect, vaultPath, extraExts }: FileTreeProps) {
  const [sortMode, setSortMode] = useState<SortMode>("modified-desc");
  const [dirsFirst, setDirsFirst] = useState(true);
  // 展开状态取反义（默认空集 = 全部折叠，类 Obsidian）；按 vault 持久化
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(storageKey(vaultPath));
      if (raw) return new Set(JSON.parse(raw) as string[]);
    } catch { /* 损坏则回退默认 */ }
    return new Set();
  });

  const tree = buildTree(files, sortMode, dirsFirst, extraExts);
  const noteCount = files.filter(f => !f.is_dir && isRenderableFile(f.path, extraExts)).length;

  // 持久化展开状态（仅针对当前 vault）
  useEffect(() => {
    if (!vaultPath) return;
    try { localStorage.setItem(storageKey(vaultPath), JSON.stringify([...expanded])); } catch { /* 忽略 */ }
  }, [expanded, vaultPath]);

  // 打开/跳转文件时自动展开其所在目录（Obsidian 行为）
  useEffect(() => {
    if (!activeFile) return;
    const dirs = ancestorDirs(activeFile);
    if (dirs.length === 0) return;
    setExpanded(prev => {
      if (dirs.every(d => prev.has(d))) return prev;
      const next = new Set(prev);
      for (const d of dirs) next.add(d);
      return next;
    });
  }, [activeFile]);

  const collectDirKeys = (nodes: TreeNode[], acc = new Set<string>()): Set<string> => {
    for (const n of nodes) {
      if (n.isDir) { acc.add(n.path || n.name); collectDirKeys(n.children, acc); }
    }
    return acc;
  };

  const smallBtn: React.CSSProperties = {
    flex: 1, fontSize: 11, padding: "2px 0", border: "1px solid #ddd", borderRadius: 3,
    background: "#fff", cursor: "pointer", color: "#555",
  };

  return (
    <div style={{ width: 260, minWidth: 200, background: "#fafafa", borderRight: "1px solid #e0e0e0", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {/* Sort controls */}
      <div style={{ padding: "6px 10px", borderBottom: "1px solid #eee", display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontWeight: 600, fontSize: 13, color: "#555" }}>📁 {noteCount}</span>
          <label style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
            <input type="checkbox" checked={dirsFirst} onChange={e => setDirsFirst(e.target.checked)} />
            目录优先
          </label>
        </div>
        <select value={sortMode} onChange={e => setSortMode(e.target.value as SortMode)}
          style={{ fontSize: 11, padding: "2px 4px", border: "1px solid #ddd", borderRadius: 3, background: "#fff" }}>
          <option value="modified-desc">修改时间 ↓</option>
          <option value="modified-asc">修改时间 ↑</option>
          <option value="name-asc">名称 A-Z</option>
          <option value="name-desc">名称 Z-A</option>
          <option value="size-desc">大小 ↓</option>
          <option value="size-asc">大小 ↑</option>
        </select>
        {/* 批量展开/折叠 */}
        <div style={{ display: "flex", gap: 4 }}>
          <button style={smallBtn} onClick={() => setExpanded(collectDirKeys(tree))}>展开全部</button>
          <button style={smallBtn} onClick={() => setExpanded(new Set())}>折叠全部</button>
        </div>
      </div>

      {/* Tree */}
      <div style={{ flex: 1, overflowY: "auto", padding: "4px 0" }}>
        {tree.map(item => (
          <TreeItem key={item.path || item.name} item={item} depth={0}
            activeFile={activeFile} onSelect={onSelect}
            expanded={expanded} setExpanded={setExpanded} />
        ))}
      </div>
    </div>
  );
});

interface TreeNode { name: string; path?: string; isDir: boolean; modified: number; size: number; children: TreeNode[]; }

function TreeItem({ item, depth, activeFile, onSelect, expanded, setExpanded }: {
  item: TreeNode; depth: number; activeFile: string; onSelect: (p: string) => void;
  expanded: Set<string>; setExpanded: (s: Set<string> | ((prev: Set<string>) => Set<string>)) => void;
}) {
  const key = item.path || item.name;
  const isCollapsed = item.isDir && !expanded.has(key);
  const indent = depth * 16;

  if (item.isDir) {
    return (
      <>
        <div data-nf-dir={item.name}
          style={{ padding: "3px 12px", paddingLeft: 12 + indent, cursor: "pointer", fontSize: 13, color: "#555", fontWeight: 500, display: "flex", alignItems: "center", gap: 4 }}
          onClick={() => setExpanded(prev => {
            const n = new Set(prev);
            if (isCollapsed) n.add(key); else n.delete(key);
            return n;
          })}>
          <span>{isCollapsed ? "▶" : "▼"}</span>
          <span>📁 {item.name}</span>
        </div>
        {!isCollapsed && item.children.map(c => (
          <TreeItem key={c.path || c.name} item={c} depth={depth + 1}
            activeFile={activeFile} onSelect={onSelect} expanded={expanded} setExpanded={setExpanded} />
        ))}
      </>
    );
  }

  const isHtml = /\.html?$/i.test(item.name);
  return (
    <div data-nf-file={item.name}
      style={{ padding: "3px 12px", paddingLeft: 12 + indent, cursor: "pointer", fontSize: 13,
        background: activeFile === item.path ? "#d2e3fc" : "transparent", color: "#333", display: "flex", alignItems: "center", gap: 4 }}
      onClick={() => item.path && onSelect(item.path)}
      onMouseEnter={e => { if (activeFile !== item.path) (e.target as HTMLElement).style.background = "#e8f0fe"; }}
      onMouseLeave={e => { if (activeFile !== item.path) (e.target as HTMLElement).style.background = "transparent"; }}>
      <span>{isHtml ? "🌐" : "📝"}</span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{item.name}</span>
      <span style={{ fontSize: 10, color: "#999" }}>{fmtTime(item.modified)}</span>
    </div>
  );
}

function fmtTime(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function buildTree(
  files: FileEntry[],
  sortMode: SortMode,
  dirsFirst: boolean,
  extraExts: readonly string[] = [],
): TreeNode[] {
  const visible = files.filter(f => !f.is_dir && isRenderableFile(f.path, extraExts));
  const root: TreeNode[] = [];
  const dirMap = new Map<string, TreeNode>();

  const sorted = [...visible].sort((a, b) => {
    let cmp = 0;
    if (sortMode === "name-asc") cmp = a.path.localeCompare(b.path);
    else if (sortMode === "name-desc") cmp = b.path.localeCompare(a.path);
    else if (sortMode === "modified-desc") cmp = b.modified - a.modified;
    else if (sortMode === "modified-asc") cmp = a.modified - b.modified;
    else if (sortMode === "size-desc") cmp = b.size - a.size;
    else if (sortMode === "size-asc") cmp = a.size - b.size;
    return cmp;
  });

  const sortDirs = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (dirsFirst) { if (a.isDir && !b.isDir) return -1; if (!a.isDir && b.isDir) return 1; }
      if (sortMode === "name-asc" || sortMode === "name-desc") return sortMode === "name-asc" ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name);
      return 0;
    });
    for (const n of nodes) if (n.children.length > 0) sortDirs(n.children);
  };

  // Ensure a directory node exists; creates parent dirs recursively.
  const ensureDir = (dirPath: string): TreeNode => {
    let existing = dirMap.get(dirPath);
    if (existing) return existing;
    const parts = dirPath.split('/');
    const name = parts[parts.length - 1];
    const parentPath = parts.slice(0, -1).join('/');
    const dirEntry = files.find(f => f.is_dir && f.path === dirPath);
    existing = { name, path: dirPath, isDir: true, modified: dirEntry?.modified || 0, size: 0, children: [] };
    dirMap.set(dirPath, existing);
    if (parentPath) {
      const parent = ensureDir(parentPath);
      parent.children.push(existing);
    } else {
      root.push(existing);
    }
    return existing;
  };

  for (const file of sorted) {
    const parts = file.path.split('/');
    const fileName = parts.pop()!;
    const dirPath = parts.join('/');
    if (dirPath) {
      const parent = ensureDir(dirPath);
      parent.children.push({ name: fileName, path: file.path, isDir: false, modified: file.modified, size: file.size, children: [] });
    } else {
      root.push({ name: fileName, path: file.path, isDir: false, modified: file.modified, size: file.size, children: [] });
    }
  }

  sortDirs(root);
  return root;
}

export default FileTree;
