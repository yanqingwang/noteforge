import { memo } from "react";

const StatusBar = memo(function StatusBar({ text }: { text: string }) {
  return (
    <div style={{ padding: "4px 12px", background: "#f0f0f0", borderTop: "1px solid #ddd", fontSize: 12, color: "#666" }}>
      {text}
    </div>
  );
});

export default StatusBar;
