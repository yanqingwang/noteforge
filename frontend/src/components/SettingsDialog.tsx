import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Icon } from "./Icon";
import {
  Settings, Cloud, Lock, RefreshCw, ClipboardList, SlidersHorizontal,
  Filter, Trash2, ImageDown, GitMerge, FolderCog, ScrollText, Activity,
} from "lucide-react";
import { resetLazyAttachmentCache } from "../editor/imageSrc";

const hStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6 };

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
  purged?: number;
  indexed?: number;
  held?: number;
  blocked?: number;
  items: { path: string; action: string; ok: boolean; message: string }[];
}

const monoStyle: React.CSSProperties = {
  width: "100%", height: 64, padding: 10, fontSize: 13,
  border: "1px solid #ddd", borderRadius: 6, resize: "vertical",
  fontFamily: '"SF Mono", Consolas, monospace', boxSizing: "border-box",
};
const labelStyle: React.CSSProperties = { fontSize: 13, fontWeight: 500, display: "block", marginBottom: 4 };
const hintStyle: React.CSSProperties = { color: "#999", fontSize: 11, margin: "-4px 0 10px" };
const checkStyle: React.CSSProperties = {
  fontSize: 12.5, display: "flex", alignItems: "center", gap: 8, margin: "0 0 8px", cursor: "pointer",
};

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "8px 10px", fontSize: 13, border: "1px solid #ddd", borderRadius: 6, marginBottom: 8, boxSizing: "border-box",
};

export default function SettingsDialog({ open, onClose, onVaultReopen, onSyncStatus }: SettingsDialogProps) {
  const [excludeDirs, setExcludeDirs] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [attachmentDirs, setAttachmentDirs] = useState("");
  const [attachmentLinkStyle, setAttachmentLinkStyle] = useState("wikilink");
  const [attachmentNameStyle, setAttachmentNameStyle] = useState("timestamp");
  const [attachmentSubfolder, setAttachmentSubfolder] = useState(true);
  const [imageRenderMode, setImageRenderMode] = useState("data");
  const [attachmentLinkFormat, setAttachmentLinkFormat] = useState("absolute");
  const [attachmentConvertWebp, setAttachmentConvertWebp] = useState(false);
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
  const [autoSyncMinutes, setAutoSyncMinutes] = useState(0);
  const [syncOnStartup, setSyncOnStartup] = useState(false);
  const [syncStatus, setSyncStatus] = useState("");
  const [report, setReport] = useState<SyncReport | null>(null);
  const [showFirstSyncChoice, setShowFirstSyncChoice] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // ── Advanced sync capabilities (migrated from the yanc plugin) ──
  const [excludedExtensions, setExcludedExtensions] = useState("");
  const [purgeRemote, setPurgeRemote] = useState(false);
  const [syncOnlyFolders, setSyncOnlyFolders] = useState("");
  const [syncExcludedFolders, setSyncExcludedFolders] = useState("");
  const [excludeHiddenFiles, setExcludeHiddenFiles] = useState(true);
  const [excludeDotFolders, setExcludeDotFolders] = useState(true);
  const [excludeUnderscoreFiles, setExcludeUnderscoreFiles] = useState(false);
  const [excludeUnderscoreFolders, setExcludeUnderscoreFolders] = useState(false);
  const [maxFileSizeMB, setMaxFileSizeMB] = useState(0);
  const [lazyAttachments, setLazyAttachments] = useState(false);
  const [lazyFolders, setLazyFolders] = useState("");
  const [autoMergeTypes, setAutoMergeTypes] = useState("txt\nmd");
  const [autoMergeStrategy, setAutoMergeStrategy] = useState("merge");
  const [otherStrategy, setOtherStrategy] = useState("latest-mtime");
  const [massDeleteLimit, setMassDeleteLimit] = useState(-1);
  const [syncConfigFolder, setSyncConfigFolder] = useState(false);
  const [configSyncBookmarks, setConfigSyncBookmarks] = useState(true);
  const [configSyncOthers, setConfigSyncOthers] = useState(true);
  const [deviceName, setDeviceName] = useState("");
  const [logsFolder, setLogsFolder] = useState("");
  const [loggingEnabled, setLoggingEnabled] = useState(false);
  const [startupDelay, setStartupDelay] = useState(1);
  const [concurrency, setConcurrency] = useState(16);
  const [watchOnChange, setWatchOnChange] = useState(true);

  useEffect(() => {
    if (!open) return;
    setMessage("");
    invoke("get_config", {}).then((cfg: any) => {
      setExcludeDirs((cfg.exclude_dirs || []).join("\n"));
      setShowHidden(cfg.show_hidden || false);
      setAttachmentDirs(cfg.attachment_dir || "attachments");
      setAttachmentLinkStyle(cfg.attachment_link_style || "wikilink");
      setAttachmentNameStyle(cfg.attachment_name_style || "timestamp");
      setAttachmentSubfolder(cfg.attachment_subfolder !== false);
      setImageRenderMode(cfg.image_render_mode || "data");
      setAttachmentLinkFormat(cfg.attachment_link_format || "absolute");
      setAttachmentConvertWebp(!!cfg.attachment_convert_webp);
    }).catch((e: any) => setMessage(`加载配置失败: ${e}`));
    invoke("sync_get_config", {}).then((cfg: any) => {
      if (cfg) {
        setSyncUrl(cfg.server_url || "");
        setSyncUser(cfg.username || "");
        setRemoteRoot(cfg.remote_root || "NoteForge");
        setEncrypted(cfg.encrypted !== false);
        setDirection(cfg.direction || "bidirectional");
        setIgnoreRules((cfg.ignore_rules || []).join("\n"));
        setAutoSyncMinutes(cfg.auto_sync_minutes || 0);
        setSyncOnStartup(!!cfg.sync_on_startup);
        // Advanced capabilities
        setExcludedExtensions((cfg.excluded_extensions || []).join("\n"));
        setPurgeRemote(!!cfg.purge_excluded_extensions_remote);
        setSyncOnlyFolders((cfg.sync_only_folders || []).join("\n"));
        setSyncExcludedFolders((cfg.excluded_folders || []).join("\n"));
        setExcludeHiddenFiles(cfg.exclude_hidden_files !== false);
        setExcludeDotFolders(cfg.exclude_dot_folders !== false);
        setExcludeUnderscoreFiles(!!cfg.exclude_underscore_files);
        setExcludeUnderscoreFolders(!!cfg.exclude_underscore_folders);
        setMaxFileSizeMB(cfg.max_file_size_mb || 0);
        setLazyAttachments(!!cfg.lazy_sync_attachments);
        setLazyFolders((cfg.lazy_attachment_folders || []).join("\n"));
        setAutoMergeTypes((cfg.auto_merge_file_types || []).join("\n"));
        setAutoMergeStrategy(cfg.auto_merge_file_strategy || "merge");
        setOtherStrategy(cfg.other_file_strategy || "latest-mtime");
        setMassDeleteLimit(typeof cfg.mass_delete_limit === "number" ? cfg.mass_delete_limit : -1);
        setSyncConfigFolder(!!cfg.sync_config_folder);
        setConfigSyncBookmarks(cfg.config_sync_bookmarks !== false);
        setConfigSyncOthers(cfg.config_sync_others !== false);
        setDeviceName(cfg.device_name || "");
        setLogsFolder(cfg.logs_folder || "");
        setLoggingEnabled(!!cfg.logging_enabled);
        setStartupDelay(typeof cfg.startup_sync_delay_seconds === "number" ? cfg.startup_sync_delay_seconds : 1);
        setConcurrency(cfg.network_concurrency || 16);
        setWatchOnChange(cfg.watch_on_change_enabled !== false);
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

  // 把文本域按行拆成列表（忽略空行）
  const lines = (v: string) => v.split("\n").map((s: string) => s.trim()).filter(Boolean);

  const buildConfig = () => ({
    server_url: syncUrl.trim(),
    username: syncUser.trim(),
    app_password: appPassword,
    remote_root: remoteRoot.trim() || "NoteForge",
    ignore_rules: lines(ignoreRules),
    direction,
    sync_password: syncPassword,
    encrypted,
    auto_sync_minutes: autoSyncMinutes,
    sync_on_startup: syncOnStartup,
    // ── 高级能力（yanc 插件迁移）──
    excluded_extensions: lines(excludedExtensions).map((s: string) => s.replace(/^\./, "").toLowerCase()),
    purge_excluded_extensions_remote: purgeRemote,
    excluded_folders: lines(syncExcludedFolders),
    sync_only_folders: lines(syncOnlyFolders),
    exclude_hidden_files: excludeHiddenFiles,
    exclude_dot_folders: excludeDotFolders,
    exclude_underscore_files: excludeUnderscoreFiles,
    exclude_underscore_folders: excludeUnderscoreFolders,
    max_file_size_mb: Number(maxFileSizeMB) || 0,
    lazy_sync_attachments: lazyAttachments,
    lazy_attachment_folders: lines(lazyFolders),
    // 「@obsidian」占位符展开成应用自身的附件目录
    obsidian_attachment_folder: attachmentDirs.trim() || "attachments",
    auto_merge_file_types: lines(autoMergeTypes),
    auto_merge_file_strategy: autoMergeStrategy,
    other_file_strategy: otherStrategy,
    mass_delete_limit: Number(massDeleteLimit),
    sync_config_folder: syncConfigFolder,
    config_sync_bookmarks: configSyncBookmarks,
    config_sync_others: configSyncOthers,
    device_name: deviceName.trim(),
    logs_folder: logsFolder.trim(),
    logging_enabled: loggingEnabled,
    startup_sync_delay_seconds: Number(startupDelay) || 0,
    network_concurrency: Math.max(1, Number(concurrency) || 1),
    watch_on_change_enabled: watchOnChange,
  });

  const saveSyncConfig = async () => {
    await invoke("sync_configure", { config: buildConfig() });
    if (appPassword || syncPassword) {
      await invoke("sync_set_passwords", { appPassword, syncPassword });
    }
    resetLazyAttachmentCache();
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
      cfg.attachment_dir = attachmentDirs.trim() || "attachments";
      cfg.attachment_link_style = attachmentLinkStyle;
      cfg.attachment_name_style = attachmentNameStyle;
      cfg.attachment_subfolder = attachmentSubfolder;
      cfg.image_render_mode = imageRenderMode;
      cfg.attachment_link_format = attachmentLinkFormat;
      cfg.attachment_convert_webp = attachmentConvertWebp;
      await invoke("update_config", { config: cfg });
      // 同步设置也一并保存（尚未填服务器地址时跳过，避免触发校验报错）
      if (syncUrl.trim()) await saveSyncConfig();
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
        <h2 style={{ margin: "0 0 16px", fontSize: 18, ...hStyle }}><Icon as={Settings} size={18} /> 设置</h2>

        {/* show_hidden toggle */}
        <label style={{ fontSize: 13, fontWeight: 500, display: "flex", alignItems: "center", gap: 8, marginBottom: 16, cursor: "pointer" }}>
          <input type="checkbox" checked={showHidden} onChange={e => setShowHidden(e.target.checked)} />
          显示隐藏文件夹（以 . 开头）
        </label>

        {/* 图片 / 附件 */}
        <label style={{ fontSize: 13, fontWeight: 500, display: "block", marginBottom: 4 }}>附件目录</label>
        <input value={attachmentDirs} onChange={e => setAttachmentDirs(e.target.value)}
          placeholder="attachments" style={inputStyle} />

        <label style={{ fontSize: 13, fontWeight: 500, display: "block", marginBottom: 4 }}>图片链接样式</label>
        <select value={attachmentLinkStyle} onChange={e => setAttachmentLinkStyle(e.target.value)} style={inputStyle}>
          <option value="wikilink">Wiki 双链 ![[……]]（默认）</option>
          <option value="markdown">Markdown ![](……)</option>
        </select>

        <label style={{ fontSize: 13, fontWeight: 500, display: "block", marginBottom: 4 }}>链接路径写法</label>
        <select value={attachmentLinkFormat} onChange={e => setAttachmentLinkFormat(e.target.value)} style={inputStyle}>
          <option value="absolute">完整路径 attachments/2026-10/xxx.png（默认）</option>
          <option value="relative">相对当前笔记 ../attachments/xxx.png</option>
          <option value="shortest">仅文件名 xxx.png（vault 内唯一时）</option>
        </select>

        <label style={{ fontSize: 13, fontWeight: 500, display: "block", marginBottom: 4 }}>图片文件名</label>
        <select value={attachmentNameStyle} onChange={e => setAttachmentNameStyle(e.target.value)} style={inputStyle}>
          <option value="timestamp">时间戳 YYYYMMDDHHmmss（默认）</option>
          <option value="sequence">序号 img-时间-序号</option>
        </select>

        <label style={{ fontSize: 13, fontWeight: 500, display: "flex", alignItems: "center", gap: 8, margin: "0 0 8px", cursor: "pointer" }}>
          <input type="checkbox" checked={attachmentSubfolder} onChange={e => setAttachmentSubfolder(e.target.checked)} />
          附件按月份分目录（YYYY-MM）
        </label>

        <label style={{ fontSize: 13, fontWeight: 500, display: "flex", alignItems: "center", gap: 8, margin: "0 0 8px", cursor: "pointer" }}>
          <input type="checkbox" checked={attachmentConvertWebp} onChange={e => setAttachmentConvertWebp(e.target.checked)} />
          粘贴时转为 WebP（png/jpg/bmp → webp，体积更小）
        </label>

        <label style={{ fontSize: 13, fontWeight: 500, display: "block", marginBottom: 4 }}>图片加载方式</label>
        <select value={imageRenderMode} onChange={e => setImageRenderMode(e.target.value)} style={inputStyle}>
          <option value="data">内嵌 Data URL（默认，兼容性最好）</option>
          <option value="asset">资源协议 asset://（大图更省内存）</option>
        </select>
        <p style={{ color: "#999", fontSize: 11, margin: "-2px 0 16px" }}>
          附件目录相对于 vault 根目录；粘贴/拖拽图片按上方「链接样式 / 文件名 / 按月分目录」规则保存并插入。
          「资源协议」需重新构建/启动应用后生效。
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
        <h3 style={{ fontSize: 15, margin: "0 0 8px", ...hStyle }}><Icon as={Cloud} size={15} /> Nextcloud 同步</h3>

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
          <span style={hStyle}><Icon as={Lock} size={13} /> 加密同步（服务器只存密文，推荐）</span>
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
          每行一个通配规则。默认已忽略 .noteforge/、.git/、*.tmp 等。
        </p>

        {/* ── Advanced sync settings (yanc plugin capabilities) ── */}
        <button onClick={() => setShowAdvanced(v => !v)}
          style={{
            display: "flex", alignItems: "center", gap: 6, width: "100%", textAlign: "left",
            padding: "8px 10px", marginBottom: 8, border: "1px solid #ddd", borderRadius: 6,
            background: "#fafafa", cursor: "pointer", fontSize: 13, fontWeight: 500,
          }}>
          <Icon as={SlidersHorizontal} size={14} /> 高级同步设置
          <span style={{ marginLeft: "auto", color: "#888", fontSize: 12 }}>{showAdvanced ? "收起 ▲" : "展开 ▼"}</span>
        </button>

        {showAdvanced && (
          <div style={{ border: "1px solid #eee", borderRadius: 8, padding: 12, marginBottom: 12 }}>
            {/* 文件类型过滤 */}
            <h4 style={{ ...hStyle, fontSize: 13, margin: "0 0 6px" }}><Icon as={Filter} size={13} /> 文件类型过滤</h4>
            <label style={labelStyle}>从不同步的扩展名</label>
            <textarea value={excludedExtensions} onChange={e => setExcludedExtensions(e.target.value)}
              placeholder={"exe\nzip\ntar.gz"} style={monoStyle} />
            <p style={hintStyle}>每行一个，不带点、不区分大小写；支持复合后缀（如 tar.gz）。</p>
            <label style={checkStyle}>
              <input type="checkbox" checked={purgeRemote} onChange={e => setPurgeRemote(e.target.checked)} />
              <span style={hStyle}><Icon as={Trash2} size={12} /> 同时清理服务器上已存在的这些类型</span>
            </label>
            <p style={hintStyle}>
              开启后同步会真实扫描一次远端并删除被排除类型的文件（不会被缓存短路），服务器回收站仍可恢复。
            </p>
            <label style={labelStyle}>单文件大小上限（MB，0 表示不限）</label>
            <input type="number" min={0} value={maxFileSizeMB}
              onChange={e => setMaxFileSizeMB(Number(e.target.value))} style={inputStyle} />

            {/* 目录范围 */}
            <h4 style={{ ...hStyle, fontSize: 13, margin: "12px 0 6px" }}><Icon as={Filter} size={13} /> 目录范围</h4>
            <label style={labelStyle}>仅同步这些文件夹（留空 = 整个笔记库）</label>
            <textarea value={syncOnlyFolders} onChange={e => setSyncOnlyFolders(e.target.value)}
              placeholder={"notes\nprojects"} style={monoStyle} />
            <p style={hintStyle}>白名单：只同步列出的目录及其子目录。</p>
            <label style={labelStyle}>同步时排除的文件夹</label>
            <textarea value={syncExcludedFolders} onChange={e => setSyncExcludedFolders(e.target.value)}
              placeholder={"archive\ntemp"} style={monoStyle} />
            <p style={hintStyle}>黑名单：优先级高于白名单。可与上方「排除目录（文件树）」不同，这里是同步层。</p>

            {/* 隐藏/下划线 */}
            <label style={checkStyle}>
              <input type="checkbox" checked={excludeHiddenFiles} onChange={e => setExcludeHiddenFiles(e.target.checked)} />
              忽略隐藏文件（以 . 开头）
            </label>
            <label style={checkStyle}>
              <input type="checkbox" checked={excludeDotFolders} onChange={e => setExcludeDotFolders(e.target.checked)} />
              忽略点文件夹（以 . 开头的目录及其内容）
            </label>
            <label style={checkStyle}>
              <input type="checkbox" checked={excludeUnderscoreFiles} onChange={e => setExcludeUnderscoreFiles(e.target.checked)} />
              忽略下划线开头的文件（_ 开头）
            </label>
            <label style={checkStyle}>
              <input type="checkbox" checked={excludeUnderscoreFolders} onChange={e => setExcludeUnderscoreFolders(e.target.checked)} />
              忽略下划线开头的文件夹
            </label>

            {/* 附件懒同步 */}
            <h4 style={{ ...hStyle, fontSize: 13, margin: "12px 0 6px" }}><Icon as={ImageDown} size={13} /> 附件懒同步</h4>
            <label style={checkStyle}>
              <input type="checkbox" checked={lazyAttachments} onChange={e => setLazyAttachments(e.target.checked)} />
              只登记附件、打开笔记时再按需下载
            </label>
            <label style={labelStyle}>懒同步目录</label>
            <textarea value={lazyFolders} onChange={e => setLazyFolders(e.target.value)}
              placeholder={"attachments\nassets/images\n@obsidian"} style={monoStyle} />
            <p style={hintStyle}>
              每行一个：写目录名（任意深度匹配）或 vault 相对路径（含 /）；
              <code>@obsidian</code> 表示用「附件目录」设置里的目录。本地新增/修改的附件仍会正常上传。
            </p>

            {/* 冲突策略 */}
            <h4 style={{ ...hStyle, fontSize: 13, margin: "12px 0 6px" }}><Icon as={GitMerge} size={13} /> 冲突处理策略</h4>
            <label style={labelStyle}>可自动合并的文件类型</label>
            <textarea value={autoMergeTypes} onChange={e => setAutoMergeTypes(e.target.value)}
              placeholder={"md\ntxt\njson"} style={{ ...monoStyle, height: 52 }} />
            <p style={hintStyle}>每行一个扩展名。Markdown 始终按「自动合并」处理。</p>
            <label style={labelStyle}>上述类型的策略</label>
            <select value={autoMergeStrategy} onChange={e => setAutoMergeStrategy(e.target.value)} style={inputStyle}>
              <option value="merge">三方合并（Clean 自动合并，冲突写标记）</option>
              <option value="biggest-size">保留较大文件</option>
              <option value="latest-mtime">保留较新文件</option>
              <option value="local-win">始终保留本地</option>
              <option value="remote-win">始终保留远端</option>
            </select>
            <label style={labelStyle}>其他文件类型的策略</label>
            <select value={otherStrategy} onChange={e => setOtherStrategy(e.target.value)} style={inputStyle}>
              <option value="latest-mtime">保留较新文件（默认）</option>
              <option value="biggest-size">保留较大文件</option>
              <option value="local-win">始终保留本地</option>
              <option value="remote-win">始终保留远端</option>
            </select>

            {/* 安全阀 */}
            <h4 style={{ ...hStyle, fontSize: 13, margin: "12px 0 6px" }}><Icon as={Trash2} size={13} /> 批量删除断路器</h4>
            <input type="number" value={massDeleteLimit}
              onChange={e => setMassDeleteLimit(Number(e.target.value))} style={inputStyle} />
            <p style={hintStyle}>
              -1 = 自动（max(20, 已跟踪文件的 20%)）；0 = 不限制（危险）；N = 单次同步最多删除 N 项。
              超过上限的删除会被跳过，避免远端列表不完整时误删整个笔记库。
            </p>

            {/* 配置文件夹同步 */}
            <h4 style={{ ...hStyle, fontSize: 13, margin: "12px 0 6px" }}><Icon as={FolderCog} size={13} /> 配置文件夹同步</h4>
            <label style={checkStyle}>
              <input type="checkbox" checked={syncConfigFolder} onChange={e => setSyncConfigFolder(e.target.checked)} />
              同步应用配置文件夹（默认关闭）
            </label>
            {syncConfigFolder && (
              <>
                <label style={checkStyle}>
                  <input type="checkbox" checked={configSyncBookmarks} onChange={e => setConfigSyncBookmarks(e.target.checked)} />
                  书签（bookmarks.json）
                </label>
                <label style={checkStyle}>
                  <input type="checkbox" checked={configSyncOthers} onChange={e => setConfigSyncOthers(e.target.checked)} />
                  其他设置：外观、主题、代码片段、快捷键、核心插件配置
                </label>
              </>
            )}
            <p style={hintStyle}>插件本体与工作区状态永远不会同步，无论上面怎么选。</p>

            {/* 运行时 */}
            <h4 style={{ ...hStyle, fontSize: 13, margin: "12px 0 6px" }}><Icon as={Activity} size={13} /> 运行时</h4>
            <label style={labelStyle}>设备名称</label>
            <input value={deviceName} onChange={e => setDeviceName(e.target.value)}
              placeholder="如：我的 MacBook" style={inputStyle} />
            <div style={{ display: "flex", gap: 8 }}>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>启动后延迟同步（秒）</label>
                <input type="number" min={0} max={10} value={startupDelay}
                  onChange={e => setStartupDelay(Number(e.target.value))} style={inputStyle} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>并发请求数</label>
                <input type="number" min={1} max={64} value={concurrency}
                  onChange={e => setConcurrency(Number(e.target.value))} style={inputStyle} />
              </div>
            </div>
            <label style={checkStyle}>
              <input type="checkbox" checked={watchOnChange} onChange={e => setWatchOnChange(e.target.checked)} />
              本文件变更后立即同步（watch）
            </label>
            <h4 style={{ ...hStyle, fontSize: 13, margin: "12px 0 6px" }}><Icon as={ScrollText} size={13} /> 日志</h4>
            <label style={checkStyle}>
              <input type="checkbox" checked={loggingEnabled} onChange={e => setLoggingEnabled(e.target.checked)} />
              写入同步日志（nf-sync.log）
            </label>
            <label style={labelStyle}>日志目录（留空 = 笔记库根目录）</label>
            <input value={logsFolder} onChange={e => setLogsFolder(e.target.value)}
              placeholder=".noteforge" style={inputStyle} />
          </div>
        )}

        <label style={{ fontSize: 13, fontWeight: 500, display: "block", marginBottom: 4 }}>自动同步</label>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
          <select value={autoSyncMinutes} onChange={e => setAutoSyncMinutes(Number(e.target.value))}
            style={{ ...inputStyle, marginBottom: 0, flex: 1 }}>
            <option value={0}>关闭</option>
            <option value={5}>每 5 分钟</option>
            <option value={15}>每 15 分钟</option>
            <option value={30}>每 30 分钟</option>
            <option value={60}>每 60 分钟</option>
          </select>
          <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 4, cursor: "pointer", whiteSpace: "nowrap" }}>
            <input type="checkbox" checked={syncOnStartup} onChange={e => setSyncOnStartup(e.target.checked)} />
            启动时同步
          </label>
        </div>

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
              <h3 style={{ margin: "0 0 8px", fontSize: 16, ...hStyle }}><Icon as={RefreshCw} size={15} /> 首次同步</h3>
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
              <h3 style={{ margin: "0 0 8px", fontSize: 16, ...hStyle }}><Icon as={ClipboardList} size={15} /> 同步报告</h3>
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
  const extra = [
    r.purged ? `清理 ${r.purged}` : "",
    r.indexed ? `登记附件 ${r.indexed}` : "",
    r.held ? `保留冲突 ${r.held}` : "",
    r.blocked ? `断路器拦截 ${r.blocked}` : "",
  ].filter(Boolean).join(" · ");
  return `上传 ${r.uploaded} · 下载 ${r.downloaded} · 冲突 ${r.conflicts} · 删除 ${r.deleted_remote + r.deleted_local}` +
    (extra ? ` · ${extra}` : "") +
    (r.errors > 0 ? ` · 失败 ${r.errors}` : "");
}

function actionLabel(a: string): string {
  switch (a) {
    case "upload": return "上传";
    case "reupload": return "重传";
    case "download": return "下载";
    case "restore": return "恢复";
    case "conflict": return "冲突";
    case "conflict-markers": return "冲突标记";
    case "conflict-local-win": return "取本地";
    case "conflict-remote-win": return "取远端";
    case "conflict-hold": return "保留两侧";
    case "conflict-noop": return "无差异";
    case "merge-clean": return "合并";
    case "index-lazy": return "登记附件";
    case "purge": return "清理远端";
    case "delete-blocked": return "拦截删除";
    case "delete-remote": return "删远端";
    case "delete-local": return "删本地";
    case "compare-equal": return "一致";
    default: return a;
  }
}
