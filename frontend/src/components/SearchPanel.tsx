import { useState } from "react";

interface SearchPanelProps {
  vaultPath: string;
  onOpenNote: (path: string) => void;
}

export default function SearchPanel({ vaultPath, onOpenNote }: SearchPanelProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ path: string; excerpt: string }[]>([]);

  const doSearch = async () => {
    if (!query.trim() || !vaultPath) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const res: { path: string; excerpt: string }[] = await invoke("search_notes", { vaultPath, query });
      setResults(res);
    } catch (e) { console.error(e); }
  };

  return (
    <div style={{ width: 280, background: "#fffbe6", borderRight: "1px solid #e0e0e0", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "10px 12px", fontWeight: 700, borderBottom: "1px solid #eee" }}>🔍 搜索</div>
      <div style={{ padding: 8, display: "flex", gap: 4 }}>
        <input value={query} onChange={e => setQuery(e.target.value)}
               onKeyDown={e => e.key === "Enter" && doSearch()}
               placeholder="搜索内容..." style={{ flex: 1, padding: "4px 8px" }} />
        <button onClick={doSearch}>搜索</button>
      </div>
      <div style={{ flex: 1, overflowY: "auto" }}>
        {results.map(r => (
          <div key={r.path} onClick={() => onOpenNote(r.path)}
               style={{ padding: "8px 12px", cursor: "pointer", borderBottom: "1px solid #f0f0f0", fontSize: 12 }}>
            📄 {r.path}
          </div>
        ))}
      </div>
    </div>
  );
}
