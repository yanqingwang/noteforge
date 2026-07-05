import { useState, useEffect, useRef } from "react";

interface AutocompleteProps {
  files: { path: string }[];
  onSelect: (path: string) => void;
  onClose: () => void;
  anchorRect: DOMRect;
  filter: string;
}

export default function WikilinkAutocomplete({ files, onSelect, onClose, anchorRect, filter }: AutocompleteProps) {
  const [query, setQuery] = useState(filter);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const results = files
    .filter(f => f.path.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 15);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIndex(i => Math.min(i + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIndex(i => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (results[selectedIndex]) onSelect(results[selectedIndex].path); }
    else if (e.key === 'Escape') { onClose(); }
  };

  return (
    <div style={{
      position: "fixed", top: anchorRect.bottom + 4, left: anchorRect.left,
      background: "white", borderRadius: 6, boxShadow: "0 4px 16px rgba(0,0,0,0.15)",
      minWidth: 280, maxHeight: 300, overflow: "auto", zIndex: 1000,
    }}>
      <div style={{ padding: "6px 10px", borderBottom: "1px solid #eee" }}>
        <input ref={inputRef} value={query} onChange={e => { setQuery(e.target.value); setSelectedIndex(0); }}
          onKeyDown={handleKeyDown}
          placeholder="搜索文件..." style={{ width: "100%", border: "none", outline: "none", fontSize: 13 }} />
      </div>
      {results.map((f, i) => (
        <div key={f.path} onClick={() => onSelect(f.path)}
          style={{ padding: "6px 10px", cursor: "pointer", fontSize: 13,
            background: i === selectedIndex ? "#e8f0fe" : "transparent",
            display: "flex", alignItems: "center", gap: 6 }}
          onMouseEnter={() => setSelectedIndex(i)}>
          <span>📝</span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.path}</span>
        </div>
      ))}
      {results.length === 0 && (
        <div style={{ padding: 12, color: "#999", fontSize: 12, textAlign: "center" }}>无匹配文件</div>
      )}
    </div>
  );
}
