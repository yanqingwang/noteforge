/**
 * 插件设置对话框：把插件自己的 PluginSettingTab（Obsidian 的 Setting 组件树）
 * 挂到 noteforge 的模态框里。
 *
 * 为什么单独一个组件：插件设置页是插件自己用 DOM 建的（Setting 组件会往
 * containerEl 里塞节点），React 不能直接渲染，只能把真实元素 append 进来。
 * 这也是 Obsidian 的做法。
 */

import { useEffect, useRef, useState } from "react";
import { obsidianRuntime } from "../plugins/obsidianRuntime";

interface PluginSettingDialogProps {
  pluginId: string;
  dark: boolean;
  onClose: () => void;
}

export default function PluginSettingDialog({ pluginId, dark, onClose }: PluginSettingDialogProps) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [tick, setTick] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const meta = obsidianRuntime.get(pluginId);

  useEffect(() => {
    const host = bodyRef.current;
    if (!host) return;
    host.replaceChildren();
    setError(null);
    // 取插件自己的设置页 DOM（settingTabsOf 内部会重跑 display()）
    const tabs = obsidianRuntime.settingTabsOf(pluginId);
    if (!tabs.length) {
      const empty = document.createElement("div");
      empty.style.opacity = "0.65";
      empty.style.padding = "12px 2px";
      empty.textContent = meta?.hasSettings
        ? "这个插件没有暴露设置页。"
        : "这个插件没有提供设置页（多数插件把配置放在视图里，或根本不需要设置）。";
      host.appendChild(empty);
      return;
    }
    for (const tab of tabs) {
      const wrap = document.createElement("div");
      wrap.className = "nf-plugin-setting-tab";
      wrap.style.marginBottom = "18px";
      wrap.appendChild(tab.el);
      host.appendChild(wrap);
    }
  }, [pluginId, tick, meta?.hasSettings]);

  // Esc 关闭
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const fg = dark ? "#ccc" : "#333";
  const border = dark ? "#3a3a3a" : "#e8e8e8";

  return (
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,.35)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 10001,
      }}
    >
      <div
        role="dialog"
        aria-label={`${meta?.name ?? pluginId} 设置`}
        style={{
          background: dark ? "#252526" : "#fff",
          color: fg,
          borderRadius: 8,
          width: "min(720px, 94vw)",
          maxHeight: "min(680px, 88vh)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          boxShadow: "0 12px 40px rgba(0,0,0,.35)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "10px 14px",
            borderBottom: `1px solid ${border}`,
          }}
        >
          <span style={{ fontWeight: 600, fontSize: 14 }}>{meta?.name ?? pluginId}</span>
          <span style={{ opacity: 0.6, fontSize: 12 }}>
            {meta?.version}
            {meta?.author ? ` · ${meta.author}` : ""}
          </span>
          <span style={{ flex: 1 }} />
          <button title="重载设置页" onClick={() => setTick((n) => n + 1)} style={btn}>
            ⟳
          </button>
          <button title="关闭" onClick={onClose} style={btn}>
            ✕
          </button>
        </div>

        {meta?.description && (
          <div style={{ padding: "8px 14px", fontSize: 12, opacity: 0.65, borderBottom: `1px solid ${border}` }}>
            {meta.description}
          </div>
        )}
        {error && (
          <div style={{ padding: "8px 14px", fontSize: 12, color: "#d33", borderBottom: `1px solid ${border}` }}>{error}</div>
        )}

        <div ref={bodyRef} style={{ flex: 1, overflow: "auto", padding: "6px 16px 14px" }} />

        <div
          style={{
            padding: "8px 14px",
            borderTop: `1px solid ${border}`,
            display: "flex",
            gap: 8,
            alignItems: "center",
            fontSize: 11,
            opacity: 0.6,
          }}
        >
          <code>.obsidian/plugins/{pluginId}/data.json</code>
          <span style={{ flex: 1 }} />
          <button onClick={onClose} style={btn}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

const btn: React.CSSProperties = {
  border: "1px solid #bbb",
  background: "transparent",
  color: "inherit",
  borderRadius: 4,
  cursor: "pointer",
  padding: "3px 10px",
  fontSize: 12,
  fontFamily: "inherit",
};
