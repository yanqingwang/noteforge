interface ToolbarProps {
  vaultPath: string;
  onOpenVault: (path: string) => void;
  onTogglePreview: () => void;
  onToggleSearch: () => void;
  showPreview: boolean;
  showSearch: boolean;
}

export default function Toolbar({ vaultPath, onOpenVault, onTogglePreview, onToggleSearch, showPreview, showSearch }: ToolbarProps) {
  const handleBrowse = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ directory: true, multiple: false });
      if (selected) onOpenVault(selected as string);
    } catch (e) {
      // Manual path input fallback
    }
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "#f0f0f0", borderBottom: "1px solid #ddd" }}>
      <button onClick={handleBrowse} style={btnStyle}>浏览...</button>
      <button onClick={() => onOpenVault(vaultPath)} style={btnStyle}>打开</button>
      <button onClick={onTogglePreview} style={btnStyle}>{showPreview ? "源码" : "预览"}</button>
      <button onClick={onToggleSearch} style={btnStyle}>{showSearch ? "关闭搜索" : "搜索"}</button>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  padding: "6px 14px", border: "1px solid #ccc", borderRadius: 4,
  background: "#fff", cursor: "pointer", fontSize: 13,
};
