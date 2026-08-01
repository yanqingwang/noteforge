import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  onVaultReopen?: () => void;
  onPasswordChange?: () => void;
  onSetPassword?: () => void;
  vaultEncrypted?: boolean;
  onSyncStatus?: (msg: string) => void;
}

export default function SettingsDialog({ open, onClose, onVaultReopen, onPasswordChange, onSetPassword, vaultEncrypted, onSyncStatus }: SettingsDialogProps) {
  const [excludeDirs, setExcludeDirs] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [attachmentDirs, setAttachmentDirs] = useState("");
  const [message, setMessage] = useState("");
  const [syncing, setSyncing] = useState(false);

  const showStatus = (msg: string) => {
    setSyncStatus(msg);
    onSyncStatus?.(msg);
  };

  // Sync settings
  const [syncType, setSyncType] = useState("webdav");
  const [syncUrl, setSyncUrl] = useState("");
  const [syncUser, setSyncUser] = useState("");
  const [syncPass, setSyncPass] = useState("");
  const [syncStatus, setSyncStatus] = useState("");
  // E2EE settings
  const [e2eeEnabled, setE2eeEnabled] = useState(false);
  const [e2eePassword, setE2eePassword] = useState("");
  const [e2eeMasterKeyId, setE2eeMasterKeyId] = useState("");

  useEffect(() => {
    if (!open) return;
    setMessage("");
    invoke("get_config", {}).then((cfg: any) => {
      setExcludeDirs((cfg.exclude_dirs || []).join("\n"));
      setShowHidden(cfg.show_hidden || false);
      setAttachmentDirs(cfg.attachment_dir || "assets");
    }).catch((e: any) => setMessage(`加载配置失败: ${e}`));
    // Load sync config
    invoke("sync_get_config", {}).then((cfg: any) => {
      if (cfg) {
        setSyncType(cfg.target_type); setSyncUrl(cfg.url); setSyncUser(cfg.username); setSyncPass(cfg.password);
        setE2eeEnabled(!!cfg.e2ee_enabled);
        setE2eeMasterKeyId(cfg.e2ee_master_key_id || "");
      }
    }).catch(() => {});
    // Listen for sync progress events from backend
    const unlisten = listen<string>("sync-progress", (event) => {
      setSyncStatus(event.payload);
      onSyncStatus?.(event.payload);
    });
    return () => { unlisten.then(fn => fn()).catch(() => {}); };
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

        <hr style={{ margin: "16px 0", border: "none", borderTop: "1px solid #eee" }} />
        <h3 style={{ fontSize: 15, margin: "0 0 8px" }}>🔐 加密设置</h3>

        {vaultEncrypted ? (
          <div style={{ marginBottom: 4 }}>
            <p style={{ fontSize: 13, color: "#38a169", margin: "0 0 8px" }}>
              ✅ 此知识库已加密（AES-256-GCM）
            </p>
            <button onClick={() => onPasswordChange?.()}
              style={{ padding: "6px 16px", border: "1px solid #e53e3e", borderRadius: 6, background: "#fff", color: "#e53e3e", cursor: "pointer", fontSize: 12 }}>
              修改密码
            </button>
          </div>
        ) : (
          <div style={{ marginBottom: 4 }}>
            <p style={{ fontSize: 13, color: "#999", margin: "0 0 8px" }}>
              加密后所有笔记内容将以 AES-256-GCM 加密存储。密码遗失无法恢复。
            </p>
            <button onClick={() => onSetPassword?.()}
              style={{ padding: "6px 16px", border: "none", borderRadius: 6, background: "#2563eb", color: "#fff", cursor: "pointer", fontSize: 12 }}>
              设置密码
            </button>
          </div>
        )}

        <hr style={{ margin: "16px 0", border: "none", borderTop: "1px solid #eee" }} />
        <h3 style={{ fontSize: 15, margin: "0 0 8px" }}>🔄 同步设置</h3>

        <label style={{ fontSize: 13, fontWeight: 500, display: "block", marginBottom: 4 }}>同步目标</label>
        <select value={syncType} onChange={e => setSyncType(e.target.value)}
          style={{ width: "100%", padding: "8px 10px", fontSize: 13, border: "1px solid #ddd", borderRadius: 6, marginBottom: 8 }}>
          <option value="webdav">WebDAV</option>
          <option value="joplin_server">Joplin Server</option>
          <option value="filesystem">本地文件系统</option>
        </select>

        <input value={syncUrl} onChange={e => setSyncUrl(e.target.value)}
          placeholder="服务器 URL (https://...)"
          style={{ width: "100%", padding: "8px 10px", fontSize: 13, border: "1px solid #ddd", borderRadius: 6, marginBottom: 8 }} />
        <input value={syncUser} onChange={e => setSyncUser(e.target.value)}
          placeholder="用户名"
          style={{ width: "100%", padding: "8px 10px", fontSize: 13, border: "1px solid #ddd", borderRadius: 6, marginBottom: 8 }} />
        <input value={syncPass} onChange={e => setSyncPass(e.target.value)}
          type="password" placeholder="密码"
          style={{ width: "100%", padding: "8px 10px", fontSize: 13, border: "1px solid #ddd", borderRadius: 6, marginBottom: 8 }} />

        {/* E2EE toggle */}
        <label style={{ fontSize: 13, fontWeight: 500, display: "flex", alignItems: "center", gap: 8, marginBottom: 8, cursor: "pointer" }}>
          <input type="checkbox" checked={e2eeEnabled} onChange={e => setE2eeEnabled(e.target.checked)} />
          🔐 启用端到端加密 (Joplin 兼容)
        </label>
        {e2eeEnabled && (
          <>
            <input value={e2eePassword} onChange={e => setE2eePassword(e.target.value)}
              type="password" placeholder="E2EE 主密钥密码（保存到服务器前加密所有笔记）"
              style={{ width: "100%", padding: "8px 10px", fontSize: 13, border: "1px solid #ddd", borderRadius: 6, marginBottom: 8 }} />
            {e2eeMasterKeyId && (
              <p style={{ fontSize: 11, color: "#666", margin: "0 0 8px" }}>
                主密钥 ID: <code style={{ fontSize: 11 }}>{e2eeMasterKeyId}</code>（已在服务器上启用加密）
              </p>
            )}
          </>
        )}

        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <button onClick={async () => {
            if (syncing) return;
            setSyncing(true); showStatus("⏳ 正在测试连接...");
            try {
              await invoke("sync_configure", { config: { target_type: syncType, url: syncUrl, username: syncUser, password: syncPass, e2ee_enabled: e2eeEnabled, e2ee_password: e2eePassword, e2ee_master_key_id: e2eeMasterKeyId, e2ee_master_key_content: "" } });
              const res = await invoke("sync_test", {});
              showStatus(`✅ ${res}`);
            } catch (e: any) { showStatus(`❌ ${e}`); }
            finally { setSyncing(false); }
          }} disabled={syncing}
            style={{ padding: "6px 16px", border: "1px solid #2563eb", borderRadius: 6,
              background: "#fff", color: syncing ? "#999" : "#2563eb", cursor: syncing ? "not-allowed" : "pointer", fontSize: 12 }}>
            {syncing ? "⏳ ..." : "测试连接"}
          </button>
          <button onClick={async () => {
            if (syncing) return;
            setSyncing(true); showStatus("⏳ 正在同步...");
            try {
              await invoke("sync_configure", { config: { target_type: syncType, url: syncUrl, username: syncUser, password: syncPass, e2ee_enabled: e2eeEnabled, e2ee_password: e2eePassword, e2ee_master_key_id: e2eeMasterKeyId, e2ee_master_key_content: "" } });
              const res = await invoke("sync_start", {});
              showStatus(`✅ ${res}`);
            } catch (e: any) { showStatus(`❌ ${e}`); }
            finally { setSyncing(false); }
          }} disabled={syncing}
            style={{ padding: "6px 16px", border: "none", borderRadius: 6,
              background: syncing ? "#93c5fd" : "#2563eb", color: "#fff",
              cursor: syncing ? "not-allowed" : "pointer", fontSize: 12 }}>
            {syncing ? "⏳ 同步中..." : "立即同步"}
          </button>
        </div>
        <p style={{ fontSize: 11, color: "#999", margin: "4px 0 8px" }}>
          本地优先同步：推送本地修改到服务器，拉取远程修改到本地。冲突通过时间戳解决。
        </p>

        <div style={{ display: "flex", gap: 8, marginBottom: 8, borderTop: "1px solid #ffe0e0", paddingTop: 8 }}>
          <button onClick={async () => {
            if (syncing) return;
            if (!confirm("⚠️ 将覆盖服务器上所有文件，不可撤销。确定继续？")) return;
            setSyncing(true); showStatus("⏳ 正在初始化上传...");
            try {
              await invoke("sync_configure", { config: { target_type: syncType, url: syncUrl, username: syncUser, password: syncPass, e2ee_enabled: e2eeEnabled, e2ee_password: e2eePassword, e2ee_master_key_id: e2eeMasterKeyId, e2ee_master_key_content: "" } });
              const res = await invoke("sync_initial_upload", {});
              showStatus(`✅ ${res}`);
            } catch (e: any) { showStatus(`❌ ${e}`); }
            finally { setSyncing(false); }
          }} disabled={syncing}
            style={{ padding: "6px 12px", border: "1px solid #e53e3e", borderRadius: 6,
              background: "#fff", color: syncing ? "#ccc" : "#e53e3e", cursor: syncing ? "not-allowed" : "pointer", fontSize: 11 }}>
            ⬆ 覆盖服务器
          </button>
          <button onClick={async () => {
            if (syncing) return;
            if (!confirm("⚠️ 将覆盖本地所有文件，不可撤销。确定继续？")) return;
            setSyncing(true); showStatus("⏳ 正在初始化下载...");
            try {
              await invoke("sync_configure", { config: { target_type: syncType, url: syncUrl, username: syncUser, password: syncPass, e2ee_enabled: e2eeEnabled, e2ee_password: e2eePassword, e2ee_master_key_id: e2eeMasterKeyId, e2ee_master_key_content: "" } });
              const res = await invoke("sync_initial_download", {});
              showStatus(`✅ ${res}`);
            } catch (e: any) { showStatus(`❌ ${e}`); }
            finally { setSyncing(false); }
          }} disabled={syncing}
            style={{ padding: "6px 12px", border: "1px solid #e53e3e", borderRadius: 6,
              background: "#fff", color: syncing ? "#ccc" : "#e53e3e", cursor: syncing ? "not-allowed" : "pointer", fontSize: 11 }}>
            ⬇ 覆盖本地
          </button>
        </div>
        <p style={{ fontSize: 10, color: "#e53e3e", margin: "0 0 8px" }}>
          ⚠️ 覆盖操作将完全替换目标端数据，请谨慎使用。
        </p>
        {syncStatus && <p style={{ fontSize: 12, margin: "4px 0", maxWidth: "100%", wordBreak: "break-word" }}>{syncStatus}</p>}

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
