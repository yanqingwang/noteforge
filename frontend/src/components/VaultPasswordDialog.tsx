import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

export type PasswordMode = "set" | "unlock" | "change";

interface VaultPasswordDialogProps {
  open: boolean;
  mode: PasswordMode;
  onClose: () => void;
  onUnlocked?: () => void;       // Called after successful unlock/set
}

export default function VaultPasswordDialog({ open, mode, onClose, onUnlocked }: VaultPasswordDialogProps) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [oldPassword, setOldPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    // Reset state
    setPassword(""); setConfirm(""); setOldPassword(""); setError(""); setLoading(false);
    // Focus password input
    setTimeout(() => inputRef.current?.focus(), 100);

    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Enter") handleSubmit();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, mode]);

  const handleSubmit = async () => {
    setError("");
    if (!password) { setError("请输入密码"); return; }

    if (mode === "set") {
      if (password !== confirm) { setError("两次密码不一致"); return; }
      if (password.length < 4) { setError("密码至少 4 位"); return; }
    }

    if (mode === "change") {
      if (!oldPassword) { setError("请输入旧密码"); return; }
      if (password !== confirm) { setError("两次新密码不一致"); return; }
      if (password.length < 4) { setError("新密码至少 4 位"); return; }
    }

    setLoading(true);
    try {
      if (mode === "set") {
        await invoke("vault_set_password", { password });
      } else if (mode === "unlock") {
        await invoke("vault_unlock", { password });
      } else if (mode === "change") {
        await invoke("vault_change_password", { oldPassword, newPassword: password });
      }
      onUnlocked?.();
      onClose();
    } catch (e: any) {
      const msg = String(e);
      if (msg.toLowerCase().includes("wrong") || msg.includes("错误")) {
        setError(mode === "unlock" ? "密码错误" : "旧密码错误");
      } else if (msg.includes("not encrypted")) {
        setError("该库未启用加密");
      } else {
        setError(msg.length > 80 ? msg.slice(0, 80) + "..." : msg);
      }
    } finally {
      setLoading(false);
    }
  };

  if (!open) return null;

  const titles: Record<PasswordMode, string> = {
    set: "🔐 设置库密码",
    unlock: "🔓 解锁库",
    change: "🔄 修改密码",
  };

  const subtitles: Record<PasswordMode, string> = {
    set: "为此知识库设置密码。设置后所有笔记内容将被加密存储。\n请妥善保管密码，遗失后无法恢复数据。",
    unlock: "此知识库已加密，请输入密码解锁。",
    change: "请输入旧密码并设置新密码。",
  };

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 3000,
      display: "flex", alignItems: "center", justifyContent: "center",
      background: "rgba(0,0,0,0.4)",
    }} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{
        background: "white", borderRadius: 12, padding: 32, minWidth: 380, maxWidth: 440,
        boxShadow: "0 12px 40px rgba(0,0,0,0.25)",
      }}>
        <h2 style={{ margin: "0 0 8px", fontSize: 20, fontWeight: 600 }}>{titles[mode]}</h2>
        <p style={{ margin: "0 0 20px", fontSize: 13, color: "#666", whiteSpace: "pre-line", lineHeight: 1.5 }}>
          {subtitles[mode]}
        </p>

        {/* Old password (change mode only) */}
        {mode === "change" && (
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 13, fontWeight: 500, display: "block", marginBottom: 4 }}>旧密码</label>
            <input type="password" value={oldPassword}
              onChange={e => setOldPassword(e.target.value)}
              placeholder="输入当前密码"
              style={inputStyle} />
          </div>
        )}

        {/* Password */}
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 13, fontWeight: 500, display: "block", marginBottom: 4 }}>
            {mode === "change" ? "新密码" : "密码"}
          </label>
          <input ref={inputRef} type="password" value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder={mode === "set" ? "设置密码（至少4位）" : "输入密码"}
            style={inputStyle} />
        </div>

        {/* Confirm password (set & change modes) */}
        {(mode === "set" || mode === "change") && (
          <div style={{ marginBottom: 4 }}>
            <label style={{ fontSize: 13, fontWeight: 500, display: "block", marginBottom: 4 }}>
              确认密码
            </label>
            <input type="password" value={confirm}
              onChange={e => setConfirm(e.target.value)}
              placeholder="再次输入密码"
              style={inputStyle} />
          </div>
        )}

        {/* Error */}
        {error && (
          <p style={{ color: "#e53e3e", fontSize: 13, margin: "12px 0 0" }}>❌ {error}</p>
        )}

        {/* Buttons */}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 20 }}>
          {/* Cancel - not available in unlock mode */}
          {mode !== "unlock" && (
            <button onClick={onClose}
              style={{ padding: "8px 18px", border: "1px solid #ddd", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 13 }}>
              取消
            </button>
          )}
          <button onClick={handleSubmit} disabled={loading}
            style={{
              padding: "8px 24px", border: "none", borderRadius: 6,
              background: loading ? "#93c5fd" : "#2563eb",
              color: "#fff", cursor: loading ? "not-allowed" : "pointer",
              fontSize: 13, fontWeight: 500,
            }}>
            {loading ? "处理中..." : mode === "set" ? "设置密码" : mode === "unlock" ? "解锁" : "修改密码"}
          </button>
        </div>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "10px 12px", fontSize: 14,
  border: "1px solid #ddd", borderRadius: 8,
  outline: "none", boxSizing: "border-box",
};
