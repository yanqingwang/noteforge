import { useState, useEffect, useRef } from "react";

interface Command {
  id: string; name: string; shortcut?: string; action: () => void;
}

interface CommandPaletteProps {
  commands: Command[];
  onClose: () => void;
}

export default function CommandPalette({ commands, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const results = commands.filter(c =>
    c.name.toLowerCase().includes(query.toLowerCase())
  ).slice(0, 15);

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
          placeholder="输入命令..." style={{
            width: "100%", padding: "12px 16px", border: "none", outline: "none",
            fontSize: 16, borderBottom: "1px solid #eee",
          }} />
        <div style={{ maxHeight: 350, overflowY: "auto" }}>
          {results.map(c => (
            <div key={c.id} onClick={() => { c.action(); onClose(); }}
              style={{ padding: "8px 16px", cursor: "pointer", fontSize: 14,
                display: "flex", justifyContent: "space-between", alignItems: "center" }}
              onMouseEnter={e => (e.currentTarget.style.background = "#f0f0f0")}
              onMouseLeave={e => (e.currentTarget.style.background = "")}>
              <span>{c.name}</span>
              {c.shortcut && <span style={{ color: "#999", fontSize: 12 }}>{c.shortcut}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
