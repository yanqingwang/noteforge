import { useState, useEffect, useRef } from "react";
import { isRenderableFile } from "./FileTree";

interface QuickSwitcherProps {
  /** 完整文件树（含目录）；仅列出可打开的 .md/.html 文件 */
  files: { path: string; is_dir?: boolean }[];
  onSelect: (path: string) => void;
  onClose: () => void;
  /** 插件接管的扩展名（.mdx 之类），否则切换器里搜不到 */
  extraExts?: readonly string[];
}

export default function QuickSwitcher({ files, onSelect, onClose, extraExts = [] }: QuickSwitcherProps) {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  // 只列可打开文件（排除目录与附件），类 Obsidian 快速切换
  const results = files.filter(f =>
    !f.is_dir &&
    isRenderableFile(f.path, extraExts) &&
    f.path.toLowerCase().includes(query.toLowerCase())
  ).slice(0, 20);

  const open = (p: string) => { onSelect(p); };

  return (
    <div style={{
      position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
      background: "rgba(0,0,0,0.3)", display: "flex",
      justifyContent: "center", paddingTop: 80, zIndex: 1000,
    }} onClick={onClose}>
      <div style={{
        background: "white", borderRadius: 8, width: 500, maxHeight: 400,
        boxShadow: "0 8px 32px rgba(0,0,0,0.2)", overflow: "hidden",
      }} onClick={e => e.stopPropagation()}>
        <input ref={inputRef} value={query}
          onChange={e => { setQuery(e.target.value); setSel(0); }}
          onKeyDown={e => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel(s => Math.min(s + 1, Math.max(0, results.length - 1)));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel(s => Math.max(0, s - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (results[sel]) open(results[sel].path);
            }
          }}
          placeholder="搜索文件..." style={{
            width: "100%", padding: "12px 16px", border: "none", outline: "none",
            fontSize: 16, borderBottom: "1px solid #eee",
          }} />
        <div style={{ maxHeight: 350, overflowY: "auto" }}>
          {results.map((f, i) => (
            <div key={f.path} onClick={() => open(f.path)}
              onMouseEnter={() => setSel(i)}
              style={{
                padding: "8px 16px", cursor: "pointer", fontSize: 14,
                background: i === sel ? "#e8f0fe" : "transparent",
              }}>
              {/\.html?$/i.test(f.path) ? "🌐" : "📄"} {f.path}
            </div>
          ))}
          {query && results.length === 0 && (
            <div style={{ padding: "16px", color: "#999", textAlign: "center" }}>未找到匹配文件</div>
          )}
        </div>
      </div>
    </div>
  );
}
