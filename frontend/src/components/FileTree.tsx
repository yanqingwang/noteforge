import { useEffect, useState, memo, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
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
  /** 文件系统操作（增删改）成功后刷新树 */
  onFsChange?: () => void;
  /** 操作结果提示（走宿主状态栏） */
  onStatus?: (msg: string) => void;
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

/** 单段名称校验：非空且不含路径分隔符（新建/重命名共用） */
function validSegment(name: string): boolean {
  const t = name.trim();
  return t.length > 0 && !/[/\\]/.test(t) && t !== "." && t !== "..";
}

/** 文件树右键菜单的目标 */
interface CtxTarget { path: string; name: string; isDir: boolean; }

const FileTree = memo(function FileTree({ files, activeFile, onSelect, vaultPath, extraExts, onFsChange, onStatus }: FileTreeProps) {
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

  // ── 增删改：右键菜单 + 顶部快捷按钮 ──────────────────────────────
  const [ctx, setCtx] = useState<{ x: number; y: number; target: CtxTarget } | null>(null);
  const closeCtx = useCallback(() => setCtx(null), []);
  // 点击任意处 / Escape 关闭右键菜单
  useEffect(() => {
    if (!ctx) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setCtx(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ctx]);

  const say = (msg: string) => onStatus?.(msg);

  const newNote = async (dir?: string) => {
    const where = dir ? `${dir}/` : "";
    const name = prompt(`新建笔记（${where || "vault 根目录"}）:`, "新笔记.md");
    if (!name) return;
    if (!validSegment(name)) { say("⚠ 名称不能为空且不能含路径分隔符"); return; }
    const rel = `${where}${name.trim()}`;
    try {
      await invoke("create_note", { notePath: rel });
      say(`已创建: ${rel}`);
      onFsChange?.();
      // 创建即打开（Obsidian 行为）
      onSelect(rel);
    } catch (e: any) { say(`创建失败: ${e}`); }
  };

  const newFolder = async (dir?: string) => {
    const where = dir ? `${dir}/` : "";
    const name = prompt(`新建文件夹（${where || "vault 根目录"}）:`, "新文件夹");
    if (!name) return;
    if (!validSegment(name)) { say("⚠ 名称不能为空且不能含路径分隔符"); return; }
    const rel = `${where}${name.trim()}`;
    try {
      await invoke("create_folder", { folderPath: rel });
      say(`已创建文件夹: ${rel}`);
      setExpanded(prev => new Set(prev).add(rel));
      onFsChange?.();
    } catch (e: any) { say(`创建文件夹失败: ${e}`); }
  };

  const rename = async (t: CtxTarget) => {
    const name = prompt(`重命名「${t.name}」为:`, t.name);
    if (!name || name.trim() === t.name) return;
    if (!validSegment(name)) { say("⚠ 名称不能为空且不能含路径分隔符"); return; }
    const slash = t.path.lastIndexOf("/");
    const newPath = (slash >= 0 ? t.path.slice(0, slash + 1) : "") + name.trim();
    try {
      await invoke("rename_entry", { oldPath: t.path, newPath });
      say(`已重命名: ${t.path} → ${newPath}`);
      onFsChange?.();
    } catch (e: any) { say(`重命名失败: ${e}`); }
  };

  const remove = async (t: CtxTarget) => {
    const what = t.isDir ? `文件夹「${t.name}」及其全部内容` : `文件「${t.name}」`;
    if (!confirm(`确定删除${what}？\n路径: ${t.path}\n（不可恢复）`)) return;
    try {
      await invoke("delete_entry", { entryPath: t.path, recursive: t.isDir });
      say(`已删除: ${t.path}`);
      onFsChange?.();
    } catch (e: any) { say(`删除失败: ${e}`); }
  };

  const ctxItems = (t: CtxTarget): { label: string; action: () => void; danger?: boolean }[] =>
    t.isDir
      ? [
          { label: "📄 在此新建笔记", action: () => void newNote(t.path) },
          { label: "📁 在此新建文件夹", action: () => void newFolder(t.path) },
          { label: "✏ 重命名", action: () => void rename(t) },
          { label: "🗑 删除", action: () => void remove(t), danger: true },
        ]
      : [
          { label: "打开", action: () => onSelect(t.path) },
          { label: "✏ 重命名", action: () => void rename(t) },
          { label: "🗑 删除", action: () => void remove(t), danger: true },
        ];

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
        {/* 批量展开/折叠 + 新建 */}
        <div style={{ display: "flex", gap: 4 }}>
          <button style={smallBtn} onClick={() => setExpanded(collectDirKeys(tree))}>展开全部</button>
          <button style={smallBtn} onClick={() => setExpanded(new Set())}>折叠全部</button>
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          <button style={smallBtn} onClick={() => void newNote()}>＋ 笔记</button>
          <button style={smallBtn} onClick={() => void newFolder()}>＋ 文件夹</button>
        </div>
      </div>

      {/* Tree */}
      <div style={{ flex: 1, overflowY: "auto", padding: "4px 0" }}
        onContextMenu={(e) => { e.preventDefault(); setCtx(null); }}>
        {tree.map(item => (
          <TreeItem key={item.path || item.name} item={item} depth={0}
            activeFile={activeFile} onSelect={onSelect}
            expanded={expanded} setExpanded={setExpanded}
            onCtx={(target, x, y) => setCtx({ x, y, target })} />
        ))}
      </div>

      {/* 右键菜单 */}
      {ctx && (
        <div style={{ position: "fixed", inset: 0, zIndex: 9000 }} onClick={closeCtx} onContextMenu={(e) => { e.preventDefault(); closeCtx(); }}>
          <div style={{
            position: "fixed", left: Math.min(ctx.x, window.innerWidth - 180), top: Math.min(ctx.y, window.innerHeight - 160),
            minWidth: 160, background: "#fff", border: "1px solid #d0d0d0", borderRadius: 6,
            boxShadow: "0 4px 16px rgba(0,0,0,.18)", padding: 4, fontSize: 13, color: "#333",
          }} onClick={(e) => e.stopPropagation()}>
            {ctxItems(ctx.target).map((it) => (
              <div key={it.label}
                style={{
                  padding: "6px 10px", borderRadius: 4, cursor: "pointer",
                  color: it.danger ? "#c0392b" : "inherit", whiteSpace: "nowrap",
                }}
                onClick={() => { closeCtx(); it.action(); }}
                onMouseEnter={(e) => { (e.target as HTMLElement).style.background = "#f0f4fa"; }}
                onMouseLeave={(e) => { (e.target as HTMLElement).style.background = "transparent"; }}
              >{it.label}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
});

interface TreeNode { name: string; path?: string; isDir: boolean; modified: number; size: number; children: TreeNode[]; }

function TreeItem({ item, depth, activeFile, onSelect, expanded, setExpanded, onCtx }: {
  item: TreeNode; depth: number; activeFile: string; onSelect: (p: string) => void;
  expanded: Set<string>; setExpanded: (s: Set<string> | ((prev: Set<string>) => Set<string>)) => void;
  onCtx: (target: CtxTarget, x: number, y: number) => void;
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
          })}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onCtx({ path: item.path || item.name, name: item.name, isDir: true }, e.clientX, e.clientY); }}>
          <span>{isCollapsed ? "▶" : "▼"}</span>
          <span>📁 {item.name}</span>
        </div>
        {!isCollapsed && item.children.map(c => (
          <TreeItem key={c.path || c.name} item={c} depth={depth + 1}
            activeFile={activeFile} onSelect={onSelect} expanded={expanded} setExpanded={setExpanded}
            onCtx={onCtx} />
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
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); if (item.path) onCtx({ path: item.path, name: item.name, isDir: false }, e.clientX, e.clientY); }}
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
