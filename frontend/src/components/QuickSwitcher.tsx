import { useState, useEffect, useRef } from "react";

interface QuickSwitcherProps {
  files: { path: string }[];
  onSelect: (path: string) => void;
  onClose: () => void;
}

export default function QuickSwitcher({ files, onSelect, onClose }: QuickSwitcherProps) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const results = files.filter(f =>
    f.path.toLowerCase().includes(query.toLowerCase())
  ).slice(0, 20);

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
        <input ref={inputRef} value={query} onChange={e => setQuery(e.target.value)}
          placeholder="搜索文件..." style={{
            width: "100%", padding: "12px 16px", border: "none", outline: "none",
            fontSize: 16, borderBottom: "1px solid #eee",
          }} />
        <div style={{ maxHeight: 350, overflowY: "auto" }}>
          {results.map(f => (
            <div key={f.path} onClick={() => onSelect(f.path)}
              style={{ padding: "8px 16px", cursor: "pointer", fontSize: 14 }}
              onMouseEnter={e => (e.currentTarget.style.background = "#f0f0f0")}
              onMouseLeave={e => (e.currentTarget.style.background = "")}>
              📄 {f.path}
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
