import { useState, useEffect, useRef } from "react";
import { rankCandidates } from "../utils/matchScore";
import { getRecent, pushRecent } from "../utils/recent";

interface Command {
  id: string; name: string; shortcut?: string; action: () => void;
}

interface CommandPaletteProps {
  commands: Command[];
  onClose: () => void;
}

export default function CommandPalette({ commands, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  // 排序：命令名前缀 > 子串 > 跳字；最近执行的命令加权（按 id 记忆）
  const recentIds = getRecent("nf-recent-commands");
  const nameById = new Map(commands.map(c => [c.id, c.name]));
  const recentNames = recentIds.map(id => nameById.get(id)).filter((n): n is string => !!n);
  const results = rankCandidates(commands, query, c => c.name, recentNames, 15);

  const run = (c: Command) => {
    pushRecent("nf-recent-commands", c.id);
    c.action();
    onClose();
  };

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
              if (results[sel]) run(results[sel]);
            }
          }}
          placeholder="输入命令..." style={{
            width: "100%", padding: "12px 16px", border: "none", outline: "none",
            fontSize: 16, borderBottom: "1px solid #eee",
          }} />
        <div style={{ maxHeight: 350, overflowY: "auto" }}>
          {results.map((c, i) => (
            <div key={c.id} onClick={() => run(c)}
              style={{ padding: "8px 16px", cursor: "pointer", fontSize: 14,
                display: "flex", justifyContent: "space-between", alignItems: "center",
                background: i === sel ? "#e8f0fe" : "transparent" }}
              onMouseEnter={() => setSel(i)}>
              <span>{c.name}</span>
              {c.shortcut && <span style={{ color: "#999", fontSize: 12 }}>{c.shortcut}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
