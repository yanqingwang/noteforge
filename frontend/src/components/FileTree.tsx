import { useState, memo } from "react";
import type { FileEntry } from "../App";

type SortMode = "name-asc" | "name-desc" | "modified-desc" | "modified-asc" | "size-desc" | "size-asc";

interface FileTreeProps {
  files: FileEntry[];
  activeFile: string;
  onSelect: (path: string) => void;
}

const FileTree = memo(function FileTree({ files, activeFile, onSelect }: FileTreeProps) {
  const [sortMode, setSortMode] = useState<SortMode>("modified-desc");
  const [dirsFirst, setDirsFirst] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const tree = buildTree(files, sortMode, dirsFirst);
  const noteCount = files.filter(f => !f.is_dir && f.path.endsWith(".md")).length;

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
      </div>

      {/* Tree */}
      <div style={{ flex: 1, overflowY: "auto", padding: "4px 0" }}>
        {tree.map(item => (
          <TreeItem key={item.path || item.name} item={item} depth={0}
            activeFile={activeFile} onSelect={onSelect}
            collapsed={collapsed} setCollapsed={setCollapsed} />
        ))}
      </div>
    </div>
  );
});

interface TreeNode { name: string; path?: string; isDir: boolean; modified: number; size: number; children: TreeNode[]; }

function TreeItem({ item, depth, activeFile, onSelect, collapsed, setCollapsed }: {
  item: TreeNode; depth: number; activeFile: string; onSelect: (p: string) => void;
  collapsed: Set<string>; setCollapsed: (s: Set<string>) => void;
}) {
  const key = item.path || item.name;
  const isCollapsed = collapsed.has(key);
  const indent = depth * 16;

  if (item.isDir) {
    return (
      <>
        <div style={{ padding: "3px 12px", paddingLeft: 12 + indent, cursor: "pointer", fontSize: 13, color: "#555", fontWeight: 500, display: "flex", alignItems: "center", gap: 4 }}
          onClick={() => { const n = new Set(collapsed); if (isCollapsed) n.delete(key); else n.add(key); setCollapsed(n); }}>
          <span>{isCollapsed ? "▶" : "▼"}</span>
          <span>📁 {item.name}</span>
        </div>
        {!isCollapsed && item.children.map(c => (
          <TreeItem key={c.path || c.name} item={c} depth={depth + 1}
            activeFile={activeFile} onSelect={onSelect} collapsed={collapsed} setCollapsed={setCollapsed} />
        ))}
      </>
    );
  }

  return (
    <div style={{ padding: "3px 12px", paddingLeft: 12 + indent, cursor: "pointer", fontSize: 13,
      background: activeFile === item.path ? "#d2e3fc" : "transparent", color: "#333", display: "flex", alignItems: "center", gap: 4 }}
      onClick={() => item.path && onSelect(item.path)}
      onMouseEnter={e => { if (activeFile !== item.path) (e.target as HTMLElement).style.background = "#e8f0fe"; }}
      onMouseLeave={e => { if (activeFile !== item.path) (e.target as HTMLElement).style.background = "transparent"; }}>
      <span>📝</span>
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

function buildTree(files: FileEntry[], sortMode: SortMode, dirsFirst: boolean): TreeNode[] {
  const mdFiles = files.filter(f => !f.is_dir && f.path.endsWith(".md"));
  const root: TreeNode[] = [];
  const dirMap = new Map<string, TreeNode>();

  const sorted = [...mdFiles].sort((a, b) => {
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

  for (const file of sorted) {
    const parts = file.path.split('/');
    const fileName = parts.pop()!;
    const dirPath = parts.join('/');

    let parent = root;
    if (dirPath) {
      let currentPath = "";
      for (const p of parts) {
        currentPath = currentPath ? `${currentPath}/${p}` : p;
        // Create dir only from FileEntry that's a directory in the files list
        let dirNode = Array.from(dirMap.values()).find(d => d.name === p && d.children !== undefined);
        if (!dirNode) {
          const dirEntry = files.find(f => f.is_dir && f.path === currentPath);
          dirNode = { name: p, isDir: true, modified: dirEntry?.modified || 0, size: 0, children: [] };
          dirMap.set(currentPath, dirNode);
          root.push(dirNode);
        }
        parent = dirNode.children;
      }
    }

    parent.push({ name: fileName, path: file.path, isDir: false, modified: file.modified, size: file.size, children: [] });
  }

  sortDirs(root);
  return root;
}

export default FileTree;
