/**
 * 侧栏「插件」面板：列出已安装插件、开关、错误诊断，并挂载插件视图。
 *
 * 插件视图（ItemView）需要一个真实 DOM 容器。这里为每个已注册视图类型渲染一个
 * 挂载点，交给 obsidianRuntime.openView() 填充 —— 与 Obsidian 的「右侧叶子」等价，
 * 差别只在 noteforge 用侧栏承载而不是右侧栏。
 */

import { useEffect, useState } from "react";
import { obsidianRuntime, type PluginSummary } from "../plugins/obsidianRuntime";

interface PluginPanelProps {
  dark: boolean;
  onOpenSettings: () => void;
  onRefresh: () => void;
}

export default function PluginPanel({ dark, onOpenSettings, onRefresh }: PluginPanelProps) {
  const [plugins, setPlugins] = useState<PluginSummary[]>(() => obsidianRuntime.list());
  const [busy, setBusy] = useState<string | null>(null);
  const [currentView, setCurrentView] = useState<string | null>(null);

  useEffect(() => obsidianRuntime.subscribe(() => setPlugins(obsidianRuntime.list())), []);
  useEffect(() => obsidianRuntime.onViewChange(setCurrentView), []);

  const toggle = async (p: PluginSummary) => {
    setBusy(p.id);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("set_plugin_enabled", { vaultRoot: vaultRoot(), id: p.id, enabled: !p.enabled });
      onRefresh();
      await obsidianRuntime.reload();
      setPlugins(obsidianRuntime.list());
    } catch (e) {
      console.error("[plugin] 切换启用状态失败", e);
    } finally {
      setBusy(null);
    }
  };

  const vaultRoot = () => window.localStorage.getItem("nf-last-vault") ?? "";

  // 视图由运行时挂到右侧停靠面板，所以这里不用等 React 渲染容器
  const openView = async (type: string) => {
    await obsidianRuntime.openView(type);
  };

  const fg = dark ? "#ccc" : "#333";
  const border = dark ? "#3a3a3a" : "#e8e8e8";

  const enabled = plugins.filter((p) => p.enabled);
  const views = enabled.flatMap((p) => p.views.map((v) => ({ type: v, plugin: p })));

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", fontSize: 13, color: fg }}>
      <div style={{ padding: "8px 10px", display: "flex", gap: 6, alignItems: "center", borderBottom: `1px solid ${border}` }}>
        <span style={{ flex: 1, fontWeight: 600 }}>
          插件 {plugins.length ? `(${enabled.length}/${plugins.length} 启用)` : ""}
        </span>
        <button
          onClick={onOpenSettings}
          style={btnStyle}
          title="打开插件设置（含插件市场）"
        >
          ⚙
        </button>
        <button onClick={onRefresh} style={btnStyle} title="重新加载插件">
          ⟳
        </button>
      </div>

      <div style={{ flex: 1, overflow: "auto" }}>
        {plugins.length === 0 && (
          <div style={{ padding: 16, opacity: 0.6, lineHeight: 1.7 }}>
            还没有安装插件。
            <br />
            点右上角 ⚙ 打开「插件」设置页，可从 Obsidian 官方市场安装。
            <br />
            插件放在 <code>.obsidian/plugins/&lt;id&gt;/</code>，与 Obsidian 共享同一目录。
          </div>
        )}

        {plugins.map((p) => (
          <div key={p.id} style={{ padding: "8px 10px", borderBottom: `1px solid ${border}` }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="checkbox"
                checked={p.enabled}
                disabled={busy === p.id}
                onChange={() => void toggle(p)}
                title={p.enabled ? "点击禁用" : "点击启用"}
              />
              <span style={{ flex: 1, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {p.name}
              </span>
              <span style={{ fontSize: 11, opacity: 0.6 }}>{p.version}</span>
            </div>
            {p.error && (
              <div style={{ fontSize: 11, color: "#d33", marginTop: 4, lineHeight: 1.5, wordBreak: "break-all" }}>
                加载失败：{p.error}
              </div>
            )}
            {!p.error && p.enabled && (
              <div style={{ fontSize: 11, opacity: 0.65, marginTop: 3 }}>
                {p.commands.length > 0 && <span>命令 {p.commands.length}</span>}
                {p.commands.length > 0 && p.views.length > 0 && <span> · </span>}
                {p.views.length > 0 && <span>视图 {p.views.length}</span>}
                {p.hasSettings && <span> · 有设置</span>}
              </div>
            )}
          </div>
        ))}

        {views.length > 0 && (
          <>
            <div style={{ padding: "10px 10px 4px", fontWeight: 600, fontSize: 12, opacity: 0.8 }}>插件视图</div>
            {views.map((v) => (
              <button
                key={`${v.plugin.id}:${v.type}`}
                onClick={() => void openView(v.type)}
                title="在右侧停靠面板打开"
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  padding: "6px 12px",
                  border: "none",
                  background: currentView === v.type ? (dark ? "#333" : "#eaeaea") : "transparent",
                  color: fg,
                  cursor: "pointer",
                  fontSize: 13,
                }}
              >
                {viewLabel(v.type, v.plugin.name)}
              </button>
            ))}
          </>
        )}
      </div>

      <div style={{ padding: 8, fontSize: 11, opacity: 0.55, background: dark ? "#2a2a2a" : "#fafafa" }}>兼容性测试结论见 AIReports/noteforge-obsidian-plugin-compat-*.md</div>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  border: "1px solid #ccc",
  background: "transparent",
  borderRadius: 4,
  cursor: "pointer",
  padding: "2px 8px",
  fontSize: 12,
};

function viewLabel(type: string, pluginName: string): string {
  const tail = type.includes("-") ? type.split("-").pop() : type;
  return `${pluginName} · ${tail}`;
}
