import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  onVaultReopen?: () => void;
}

export default function SettingsDialog({ open, onClose, onVaultReopen }: SettingsDialogProps) {
  const [excludeDirs, setExcludeDirs] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [attachmentDirs, setAttachmentDirs] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!open) return;
    setMessage("");
    invoke("get_config", {}).then((cfg: any) => {
      setExcludeDirs((cfg.exclude_dirs || []).join("\n"));
      setShowHidden(cfg.show_hidden || false);
      setAttachmentDirs(cfg.attachment_dir || "assets");
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
      cfg.exclude_dirs = excludeDirs.split("\n").map((s: string) => s.trim()).filter(Boolean);
      cfg.exclude_dirs = cfg.exclude_dirs.map((d: string) => d.endsWith("/") ? d.slice(0, -1) : d);
      cfg.show_hidden = showHidden;
      cfg.attachment_dir = attachmentDirs.trim() || "assets";
      await invoke("update_config", { config: cfg });
      setMessage("✅ 已保存");
      if (onVaultReopen) setTimeout(onVaultReopen, 500);
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
        background: "white", borderRadius: 12, padding: 28, minWidth: 420, maxWidth: 500,
        boxShadow: "0 8px 32px rgba(0,0,0,0.2)",
      }}>
        <h2 style={{ margin: "0 0 16px", fontSize: 18 }}>⚙ 设置</h2>

        {/* show_hidden toggle */}
        <label style={{ fontSize: 13, fontWeight: 500, display: "flex", alignItems: "center", gap: 8, marginBottom: 16, cursor: "pointer" }}>
          <input type="checkbox" checked={showHidden} onChange={e => setShowHidden(e.target.checked)} />
          显示隐藏文件夹（以 . 开头）
        </label>

        {/* attachment_dir */}
        <label style={{ fontSize: 13, fontWeight: 500, display: "block", marginBottom: 4 }}>附件目录</label>
        <input value={attachmentDirs} onChange={e => setAttachmentDirs(e.target.value)}
          placeholder="assets"
          style={{ width: "100%", padding: "8px 10px", fontSize: 13, border: "1px solid #ddd", borderRadius: 6, marginBottom: 16 }} />
        <p style={{ color: "#999", fontSize: 11, margin: "-12px 0 16px" }}>
          附件目录用于双链中加载图片等附件，相对于 vault 根目录。
        </p>

        {/* exclude_dirs */}
        <label style={{ fontSize: 13, fontWeight: 500, display: "block", marginBottom: 4 }}>排除目录</label>
        <textarea value={excludeDirs} onChange={e => setExcludeDirs(e.target.value)}
          placeholder={"archive\ntemplate\nnode_modules"}
          style={{
            width: "100%", height: 120, padding: 10, fontSize: 13,
            border: "1px solid #ddd", borderRadius: 6, resize: "vertical",
            fontFamily: '"SF Mono", Consolas, monospace',
          }} />

        <p style={{ color: "#999", fontSize: 11, margin: "6px 0 0" }}>
          每行一个目录名，保存后生效。排除的目录不会出现在文件树中。
        </p>

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
