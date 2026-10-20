import { memo, type ReactNode } from "react";

const StatusBar = memo(function StatusBar({ text, right }: { text: string; right?: ReactNode }) {
  return (
    <div className="nf-status" style={{ padding: "4px 12px", background: "#f0f0f0", borderTop: "1px solid #ddd", fontSize: 12, color: "#666", display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{text}</span>
      {right}
    </div>
  );
});

export default StatusBar;
