import { memo, useMemo, useState } from "react";
import { Icon } from "./Icon";
import { Hash, FileText, RefreshCw, ChevronRight, ChevronDown } from "lucide-react";

export interface TagInfo {
  tag: string;
  count: number;
  files: string[];
}

interface TagPanelProps {
  tags: TagInfo[];
  dark: boolean;
  /** 当前打开的文件（高亮列表项） */
  activeFile?: string;
  onSelect: (path: string) => void;
  onRefresh: () => void;
}

/**
 * 标签面板（对标 Obsidian Tag Pane）：
 * 全库标签按引用次数排序，点击展开包含该标签的笔记列表，再点击跳转。
 * 顶部搜索框过滤标签；支持嵌套标签（`a/b` 按字面展示，点击 `a` 不匹配 `a/b`）。
 */
const TagPanel = memo(function TagPanel({ tags, dark, activeFile, onSelect, onRefresh }: TagPanelProps) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tags;
    return tags.filter(t => t.tag.toLowerCase().includes(q));
  }, [tags, query]);

  const fg = dark ? "#c8c8c8" : "#444";
  const dim = dark ? "#777" : "#999";

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "6px 8px", borderBottom: dark ? "1px solid #333" : "1px solid #eee" }}>
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="搜索标签..."
          style={{
            flex: 1, padding: "4px 8px", fontSize: 12, border: dark ? "1px solid #444" : "1px solid #ddd",
            borderRadius: 4, outline: "none", background: dark ? "#2d2d2d" : "#fff", color: fg,
          }} />
        <button onClick={onRefresh} title="重建标签索引"
          style={{ border: "none", background: "transparent", cursor: "pointer", color: dim, padding: 4, display: "inline-flex" }}>
          <Icon as={RefreshCw} size={13} />
        </button>
      </div>
      <div style={{ overflowY: "auto", flex: 1, padding: "4px 0" }}>
        {filtered.length === 0 && (
          <div style={{ padding: 12, fontSize: 12, color: dim }}>
            {tags.length === 0 ? "暂无标签（在笔记中写 #标签）" : "无匹配标签"}
          </div>
        )}
        {filtered.map(t => {
          const open = !!expanded[t.tag];
          return (
            <div key={t.tag}>
              <div
                onClick={() => setExpanded(e => ({ ...e, [t.tag]: !open }))}
                style={{
                  display: "flex", alignItems: "center", gap: 5, padding: "3px 10px",
                  cursor: "pointer", fontSize: 12.5, color: fg,
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = dark ? "#2d2d2d" : "#f0f0f0"; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
              >
                <span style={{ display: "inline-flex", color: dim, width: 12 }}>
                  <Icon as={open ? ChevronDown : ChevronRight} size={12} />
                </span>
                <span style={{ display: "inline-flex", color: dark ? "#6cb2ff" : "#0969da" }}>
                  <Icon as={Hash} size={12} />
                </span>
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.tag}</span>
                <span style={{ fontSize: 11, color: dim }}>{t.count}</span>
              </div>
              {open && t.files.map(f => (
                <div key={f}
                  onClick={() => onSelect(f)}
                  title={f}
                  style={{
                    display: "flex", alignItems: "center", gap: 5, padding: "2px 10px 2px 34px",
                    cursor: "pointer", fontSize: 12,
                    color: f === activeFile ? (dark ? "#6cb2ff" : "#0969da") : fg,
                    background: f === activeFile ? (dark ? "#1c3a5e" : "#e8f0fe") : "transparent",
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}
                  onMouseEnter={(e) => { if (f !== activeFile) (e.currentTarget as HTMLElement).style.background = dark ? "#2d2d2d" : "#f0f0f0"; }}
                  onMouseLeave={(e) => { if (f !== activeFile) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                >
                  <span style={{ display: "inline-flex", color: dim }}><Icon as={FileText} size={11} /></span>
                  {f}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
});

export default TagPanel;
