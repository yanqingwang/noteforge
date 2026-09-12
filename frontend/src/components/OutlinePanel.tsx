import { memo } from "react";
import type { OutlineItem } from "../editor/bridge";
import { requestOutlineJump } from "../editor/bridge";

interface OutlinePanelProps {
  items: OutlineItem[];
  dark: boolean;
}

const levelIndent = (level: number) => ({ paddingLeft: 8 + (level - 1) * 14 });

/** M6：大纲面板 —— 标题树，点击跳转到对应行 */
const OutlinePanel = memo(function OutlinePanel({ items, dark }: OutlinePanelProps) {
  if (items.length === 0) {
    return <div style={{ padding: "12px", fontSize: 12, color: dark ? "#777" : "#999" }}>无标题（用 # 创建大纲）</div>;
  }
  return (
    <div style={{ overflowY: "auto", flex: 1, padding: "4px 0" }}>
      {items.map((it, i) => (
        <div key={i}
          onClick={() => requestOutlineJump(it)}
          style={{
            ...levelIndent(it.level),
            padding: "3px 10px", fontSize: it.level <= 2 ? 12.5 : 12,
            fontWeight: it.level <= 2 ? 600 : 400,
            color: dark ? "#c8c8c8" : "#444",
            cursor: "pointer", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          }}
          title={it.text}
          onMouseEnter={(e) => { (e.target as HTMLElement).style.background = dark ? "#2d2d2d" : "#f0f0f0"; }}
          onMouseLeave={(e) => { (e.target as HTMLElement).style.background = "transparent"; }}
        >
          {it.text}
        </div>
      ))}
    </div>
  );
});

export default OutlinePanel;
