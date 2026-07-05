import { useState, useRef, useEffect } from "react";

export interface MenuItem {
  label?: string;
  shortcut?: string;
  action?: () => void;
  divider?: boolean;
  disabled?: boolean;
}

interface DropdownMenuProps {
  label: string;
  items: MenuItem[];
}

export default function DropdownMenu({ label, items }: DropdownMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block" }}>
      <span style={{ padding: "4px 8px", cursor: "pointer", borderRadius: 4, color: "#555", fontSize: 13 }}
        onClick={() => setOpen(!open)}
        onMouseEnter={e => (e.currentTarget.style.background = "#e0e0e0")}
        onMouseLeave={e => (e.currentTarget.style.background = "")}>
        {label}
      </span>
      {open && (
        <div style={{
          position: "absolute", top: "100%", left: 0, background: "white", minWidth: 200,
          boxShadow: "0 4px 16px rgba(0,0,0,0.15)", borderRadius: 6, padding: 4, zIndex: 1000,
        }}>
          {items.map((item, i) =>
            item.divider ? (
              <div key={i} style={{ height: 1, background: "#eee", margin: "4px 0" }} />
            ) : (
              <div key={i} onClick={() => { if (!item.disabled && item.action) { item.action(); setOpen(false); } }}
                style={{
                  padding: "6px 12px", cursor: item.disabled ? "default" : "pointer", borderRadius: 4,
                  display: "flex", justifyContent: "space-between", alignItems: "center", gap: 24,
                  fontSize: 13, color: item.disabled ? "#bbb" : "#333",
                }}
                onMouseEnter={e => { if (!item.disabled) e.currentTarget.style.background = "#f0f0f0"; }}
                onMouseLeave={e => { e.currentTarget.style.background = ""; }}>
                <span>{item.label}</span>
                {item.shortcut && <span style={{ color: "#999", fontSize: 11 }}>{item.shortcut}</span>}
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
}
