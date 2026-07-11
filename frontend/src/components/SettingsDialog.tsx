import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

export default function SettingsDialog({ open, onClose }: SettingsDialogProps) {
  const [excludeDirs, setExcludeDirs] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!open) return;
    setMessage("");
    invoke("get_config", {}).then((cfg: any) => {
      setExcludeDirs((cfg.exclude_dirs || []).join("\n"));
    }).catch((e: any) => setMessage(`加载配置失败: ${e}`));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  const handleSave = async () => {
    setMessage("");
    try {
      const cfg: any = await invoke("get_config", {});
      cfg.exclude_dirs = excludeDirs.split("\n").map(s => s.trim()).filter(Boolean);
      // Remove trailing slash for consistency
      cfg.exclude_dirs = cfg.exclude_dirs.map((d: string) => d.endsWith("/") ? d.slice(0, -1) : d);
      await invoke("update_config", { config: cfg });
      setMessage("✅ 已保存，重新打开 vault 生效");
    } catch (e: any) {
      setMessage(`❌ 保存失败: ${e}`);
    }
  };

  if (!open) return null;

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 2000,
      display: "flex", alignItems: "center", justifyContent: "center",
      background: "rgba(0,0,0,0.3)",
    }} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{
        background: "white", borderRadius: 12, padding: 28, minWidth: 400, maxWidth: 480,
        boxShadow: "0 8px 32px rgba(0,0,0,0.2)",
      }}>
        <h2 style={{ margin: "0 0 4px", fontSize: 18 }}>⚙ 设置</h2>
        <p style={{ color: "#666", fontSize: 12, margin: "0 0 16px" }}>
          排除的文件夹（每行一个），保存后需重新打开 vault 生效
        </p>

        <label style={{ fontSize: 13, fontWeight: 500, display: "block", marginBottom: 4 }}>排除目录</label>
        <textarea value={excludeDirs} onChange={e => setExcludeDirs(e.target.value)}
          placeholder={"archive\ntemplate\nnode_modules\n.git"}
          style={{
            width: "100%", height: 140, padding: 10, fontSize: 13,
            border: "1px solid #ddd", borderRadius: 6, resize: "vertical",
            fontFamily: '"SF Mono", Consolas, monospace',
          }} />

        {message && <p style={{ fontSize: 13, margin: "8px 0 0" }}>{message}</p>}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
          <button onClick={onClose}
            style={{ padding: "8px 20px", border: "1px solid #ddd", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 13 }}>
            取消
          </button>
          <button onClick={handleSave}
            style={{ padding: "8px 20px", border: "none", borderRadius: 6, background: "#2563eb", color: "#fff", cursor: "pointer", fontSize: 13 }}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
