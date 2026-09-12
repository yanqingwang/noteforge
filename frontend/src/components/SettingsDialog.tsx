import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  onVaultReopen?: () => void;
  onSyncStatus?: (msg: string) => void;
}

interface SyncReport {
  uploaded: number;
  downloaded: number;
  conflicts: number;
  deleted_remote: number;
  deleted_local: number;
  skipped: number;
  errors: number;
  first_sync: boolean;
  encrypted: boolean;
  items: { path: string; action: string; ok: boolean; message: string }[];
}

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "8px 10px", fontSize: 13, border: "1px solid #ddd", borderRadius: 6, marginBottom: 8, boxSizing: "border-box",
};

export default function SettingsDialog({ open, onClose, onVaultReopen, onSyncStatus }: SettingsDialogProps) {
  const [excludeDirs, setExcludeDirs] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [attachmentDirs, setAttachmentDirs] = useState("");
  const [message, setMessage] = useState("");
  const [syncing, setSyncing] = useState(false);

  const showStatus = (msg: string) => {
    setSyncStatus(msg);
    onSyncStatus?.(msg);
  };

  // ── Nextcloud sync settings ──
  const [syncUrl, setSyncUrl] = useState("");
  const [syncUser, setSyncUser] = useState("");
  const [appPassword, setAppPassword] = useState("");
  const [remoteRoot, setRemoteRoot] = useState("NoteForge");
  const [encrypted, setEncrypted] = useState(true);
  const [syncPassword, setSyncPassword] = useState("");
  const [direction, setDirection] = useState("bidirectional");
  const [ignoreRules, setIgnoreRules] = useState("");
  const [syncStatus, setSyncStatus] = useState("");
  const [report, setReport] = useState<SyncReport | null>(null);
  const [showFirstSyncChoice, setShowFirstSyncChoice] = useState(false);

  useEffect(() => {
    if (!open) return;
    setMessage("");
    invoke("get_config", {}).then((cfg: any) => {
      setExcludeDirs((cfg.exclude_dirs || []).join("\n"));
      setShowHidden(cfg.show_hidden || false);
      setAttachmentDirs(cfg.attachment_dir || "assets");
    }).catch((e: any) => setMessage(`加载配置失败: ${e}`));
    invoke("sync_get_config", {}).then((cfg: any) => {
      if (cfg) {
        setSyncUrl(cfg.server_url || "");
        setSyncUser(cfg.username || "");
        setRemoteRoot(cfg.remote_root || "NoteForge");
        setEncrypted(cfg.encrypted !== false);
        setDirection(cfg.direction || "bidirectional");
        setIgnoreRules((cfg.ignore_rules || []).join("\n"));
      }
    }).catch(() => {});
    const unlisten = listen<any>("sync-progress", (event) => {
      const p = event.payload;
      if (typeof p === "string") { showStatus(p); return; }
      if (p?.phase === "apply" && p.total > 0) {
        showStatus(`⏳ 同步中 ${p.done}/${p.total} ${p.path || ""}`);
      } else if (p?.phase === "backup") {
        showStatus(`⏳ 首次同步备份 ${p.done}/${p.total}`);
      } else if (p?.phase) {
        showStatus(`⏳ ${p.phase}...`);
      }
    });
    return () => { unlisten.then(fn => fn()).catch(() => {}); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  const buildConfig = () => ({
    server_url: syncUrl.trim(),
    username: syncUser.trim(),
    app_password: appPassword,
    remote_root: remoteRoot.trim() || "NoteForge",
    ignore_rules: ignoreRules.split("\n").map((s: string) => s.trim()).filter(Boolean),
    direction,
    sync_password: syncPassword,
    encrypted,
  });

  const saveSyncConfig = async () => {
    await invoke("sync_configure", { config: buildConfig() });
    if (appPassword || syncPassword) {
      await invoke("sync_set_passwords", { appPassword, syncPassword });
    }
  };

  const handleTest = async () => {
    if (syncing) return;
    setSyncing(true); showStatus("⏳ 正在测试连接...");
    try {
      await saveSyncConfig();
      const res = await invoke<string>("sync_test", {});
      showStatus(`✅ ${res}`);
    } catch (e: any) { showStatus(`❌ ${e}`); }
    finally { setSyncing(false); }
  };

  const runSync = async (firstPolicy?: string) => {
    if (syncing) return;
    setSyncing(true);
    setShowFirstSyncChoice(false);
    showStatus("⏳ 正在同步...");
    try {
      await saveSyncConfig();
      const rep = await invoke<SyncReport>("sync_start", { firstPolicy: firstPolicy ?? null });
      setReport(rep);
      showStatus(rep.errors > 0 ? `⚠ ${repSummary(rep)}` : `✅ ${repSummary(rep)}`);
    } catch (e: any) { showStatus(`❌ ${e}`); }
    finally { setSyncing(false); }
  };

  const handleSyncClick = async () => {
    if (syncing) return;
    try {
      await saveSyncConfig();
      const first = await invoke<boolean>("sync_first_sync_needed", {});
      if (first) { setShowFirstSyncChoice(true); return; }
      await runSync();
    } catch (e: any) { showStatus(`❌ ${e}`); setSyncing(false); }
  };

  const showReport = async () => {
    try {
      const rep = await invoke<SyncReport | null>("sync_get_report", {});
      if (rep) { setReport(rep); } else { showStatus("暂无同步报告"); }
    } catch (e: any) { showStatus(`❌ ${e}`); }
  };

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
        background: "white", borderRadius: 12, padding: 28, minWidth: 420, maxWidth: 520,
        maxHeight: "85vh", overflowY: "auto",
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
          placeholder="assets" style={inputStyle} />
        <p style={{ color: "#999", fontSize: 11, margin: "-12px 0 16px" }}>
          附件目录用于双链中加载图片等附件，相对于 vault 根目录。粘贴的图片会保存到这里（按月分目录）。
        </p>

        {/* exclude_dirs */}
        <label style={{ fontSize: 13, fontWeight: 500, display: "block", marginBottom: 4 }}>排除目录</label>
        <textarea value={excludeDirs} onChange={e => setExcludeDirs(e.target.value)}
          placeholder={"archive\ntemplate\nnode_modules"}
          style={{
            width: "100%", height: 90, padding: 10, fontSize: 13,
            border: "1px solid #ddd", borderRadius: 6, resize: "vertical",
            fontFamily: '"SF Mono", Consolas, monospace', boxSizing: "border-box",
          }} />

        <p style={{ color: "#999", fontSize: 11, margin: "6px 0 0" }}>
          每行一个目录名，保存后生效。排除的目录不会出现在文件树中。
        </p>

        <hr style={{ margin: "16px 0", border: "none", borderTop: "1px solid #eee" }} />
        <h3 style={{ fontSize: 15, margin: "0 0 8px" }}>☁ Nextcloud 同步</h3>

        <input value={syncUrl} onChange={e => setSyncUrl(e.target.value)}
          placeholder="Nextcloud 地址，如 https://pan.example.com"
          style={inputStyle} />
        <div style={{ display: "flex", gap: 8 }}>
          <input value={syncUser} onChange={e => setSyncUser(e.target.value)}
            placeholder="用户名" style={{ ...inputStyle, flex: 1 }} />
          <input value={appPassword} onChange={e => setAppPassword(e.target.value)}
            type="password" placeholder="应用密码（非登录密码）"
            style={{ ...inputStyle, flex: 1 }} />
        </div>
        <p style={{ color: "#999", fontSize: 11, margin: "-4px 0 8px" }}>
          应用密码在 Nextcloud「设置 → 安全 → 设备与活动」中生成。密码仅保存在本机内存，不落盘。
        </p>
        <input value={remoteRoot} onChange={e => setRemoteRoot(e.target.value)}
          placeholder="远程目录（默认 NoteForge）" style={inputStyle} />

        <label style={{ fontSize: 13, fontWeight: 500, display: "flex", alignItems: "center", gap: 8, margin: "4px 0 8px", cursor: "pointer" }}>
          <input type="checkbox" checked={encrypted} onChange={e => setEncrypted(e.target.checked)} />
          🔐 加密同步（服务器只存密文，推荐）
        </label>
        {encrypted && (
          <input value={syncPassword} onChange={e => setSyncPassword(e.target.value)}
            type="password" placeholder="同步密码（其他设备需输入同一密码才能解密）"
            style={inputStyle} />
        )}

        <label style={{ fontSize: 13, fontWeight: 500, display: "block", marginBottom: 4 }}>同步方向</label>
        <select value={direction} onChange={e => setDirection(e.target.value)} style={inputStyle}>
          <option value="bidirectional">双向（默认）</option>
          <option value="upload">仅上传</option>
          <option value="download">仅下载</option>
        </select>

        <label style={{ fontSize: 13, fontWeight: 500, display: "block", marginBottom: 4 }}>额外忽略规则（可选）</label>
        <textarea value={ignoreRules} onChange={e => setIgnoreRules(e.target.value)}
          placeholder={"drafts/\n*.pdf"}
          style={{
            width: "100%", height: 60, padding: 10, fontSize: 13,
            border: "1px solid #ddd", borderRadius: 6, resize: "vertical",
            fontFamily: '"SF Mono", Consolas, monospace', boxSizing: "border-box", marginBottom: 8,
          }} />
        <p style={{ color: "#999", fontSize: 11, margin: "-4px 0 8px" }}>
          每行一个通配规则。默认已忽略 .noteforge/、.obsidian/、.git/、*.tmp 等。
        </p>

        <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
          <button onClick={handleTest} disabled={syncing}
            style={{ padding: "6px 16px", border: "1px solid #2563eb", borderRadius: 6,
              background: "#fff", color: syncing ? "#999" : "#2563eb", cursor: syncing ? "not-allowed" : "pointer", fontSize: 12 }}>
            {syncing ? "⏳ ..." : "测试连接"}
          </button>
          <button onClick={handleSyncClick} disabled={syncing}
            style={{ padding: "6px 16px", border: "none", borderRadius: 6,
              background: syncing ? "#93c5fd" : "#2563eb", color: "#fff",
              cursor: syncing ? "not-allowed" : "pointer", fontSize: 12 }}>
            {syncing ? "⏳ 同步中..." : "立即同步"}
          </button>
          <button onClick={showReport} disabled={syncing}
            style={{ padding: "6px 16px", border: "1px solid #ddd", borderRadius: 6,
              background: "#fff", color: "#333", cursor: "pointer", fontSize: 12 }}>
            上次报告
          </button>
        </div>
        <p style={{ fontSize: 11, color: "#999", margin: "4px 0 8px" }}>
          vault 目录与 Nextcloud 指定目录 1:1 镜像；删除会进入回收站（服务器回收站 / 本地 .noteforge/trash/）。
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

        {/* ── First-sync direction choice ── */}
        {showFirstSyncChoice && (
          <div style={{
            position: "fixed", inset: 0, zIndex: 2100, display: "flex", alignItems: "center", justifyContent: "center",
            background: "rgba(0,0,0,0.4)",
          }} onClick={(e) => { if (e.target === e.currentTarget) setShowFirstSyncChoice(false); }}>
            <div style={{ background: "white", borderRadius: 12, padding: 24, minWidth: 380, maxWidth: 440, boxShadow: "0 8px 32px rgba(0,0,0,0.25)" }}>
              <h3 style={{ margin: "0 0 8px", fontSize: 16 }}>🔄 首次同步</h3>
              <p style={{ fontSize: 13, color: "#555", margin: "0 0 16px" }}>
                这是该笔记库第一次同步。请选择如何处理两侧可能都存在的数据（开始前会自动备份到 <code>.noteforge/backup-首次同步前/</code>）：
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <button onClick={() => runSync("bidirectional")} disabled={syncing}
                  style={{ padding: "10px 14px", border: "1px solid #2563eb", borderRadius: 8, background: "#fff", textAlign: "left", cursor: "pointer", fontSize: 13 }}>
                  <b>双向增量（推荐）</b><br />
                  <span style={{ color: "#777", fontSize: 12 }}>本地有→上传，远端有→下载；两侧同名但内容不同→保留冲突副本</span>
                </button>
                <button onClick={() => runSync("upload_all")} disabled={syncing}
                  style={{ padding: "10px 14px", border: "1px solid #e53e3e", borderRadius: 8, background: "#fff", textAlign: "left", cursor: "pointer", fontSize: 13 }}>
                  <b>以本地为准（全量上传）</b><br />
                  <span style={{ color: "#777", fontSize: 12 }}>本地内容覆盖服务器，服务器上多出的文件删除（进服务器回收站）</span>
                </button>
                <button onClick={() => runSync("download_all")} disabled={syncing}
                  style={{ padding: "10px 14px", border: "1px solid #e53e3e", borderRadius: 8, background: "#fff", textAlign: "left", cursor: "pointer", fontSize: 13 }}>
                  <b>以服务器为准（全量下载）</b><br />
                  <span style={{ color: "#777", fontSize: 12 }}>服务器内容覆盖本地，本地多出的文件移入 .noteforge/trash/</span>
                </button>
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
                <button onClick={() => setShowFirstSyncChoice(false)}
                  style={{ padding: "6px 16px", border: "1px solid #ddd", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 12 }}>
                  取消
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Last sync report ── */}
        {report && (
          <div style={{
            position: "fixed", inset: 0, zIndex: 2100, display: "flex", alignItems: "center", justifyContent: "center",
            background: "rgba(0,0,0,0.4)",
          }} onClick={(e) => { if (e.target === e.currentTarget) setReport(null); }}>
            <div style={{ background: "white", borderRadius: 12, padding: 24, minWidth: 420, maxWidth: 560, maxHeight: "75vh", overflowY: "auto", boxShadow: "0 8px 32px rgba(0,0,0,0.25)" }}>
              <h3 style={{ margin: "0 0 8px", fontSize: 16 }}>📋 同步报告</h3>
              <p style={{ fontSize: 12, color: "#555", margin: "0 0 12px" }}>
                {repSummary(report)}{report.encrypted ? " · 🔐 加密" : ""}{report.first_sync ? " · 首次同步" : ""}
              </p>
              {report.items.length === 0 && <p style={{ fontSize: 12, color: "#999" }}>无变更</p>}
              {report.items.map((it, i) => (
                <div key={i} style={{ fontSize: 12, padding: "4px 0", borderBottom: "1px solid #f0f0f0", display: "flex", gap: 8 }}>
                  <span style={{ color: it.ok ? "#16a34a" : "#dc2626", minWidth: 14 }}>{it.ok ? "✓" : "✗"}</span>
                  <span style={{ color: "#888", minWidth: 90 }}>{actionLabel(it.action)}</span>
                  <span style={{ flex: 1, wordBreak: "break-all" }}>{it.path}</span>
                  {!it.ok && <span style={{ color: "#dc2626" }}>{it.message}</span>}
                </div>
              ))}
              <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
                <button onClick={() => setReport(null)}
                  style={{ padding: "6px 16px", border: "1px solid #ddd", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 12 }}>
                  关闭
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function repSummary(r: SyncReport): string {
  return `上传 ${r.uploaded} · 下载 ${r.downloaded} · 冲突 ${r.conflicts} · 删除 ${r.deleted_remote + r.deleted_local}` +
    (r.errors > 0 ? ` · 失败 ${r.errors}` : "");
}

function actionLabel(a: string): string {
  switch (a) {
    case "upload": return "上传";
    case "reupload": return "重传";
    case "download": return "下载";
    case "restore": return "恢复";
    case "conflict": return "冲突";
    case "delete-remote": return "删远端";
    case "delete-local": return "删本地";
    case "compare-equal": return "一致";
    default: return a;
  }
}
