import { useEffect, useRef, useState } from "react";
import { appVersion } from "../version";

interface AboutDialogProps {
  open: boolean;
  onClose: () => void;
}

export default function AboutDialog({ open, onClose }: AboutDialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  // 版本/构建时间取自 tauri.conf.json（单一来源，避免多处硬编码漂移）
  const [version, setVersion] = useState("dev");
  const [build, setBuild] = useState("");

  useEffect(() => {
    if (!open) return;
    void appVersion().then(setVersion);
    const d = new Date();
    setBuild(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 2000,
      display: "flex", alignItems: "center", justifyContent: "center",
      background: "rgba(0,0,0,0.3)",
    }} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} style={{
        background: "white", borderRadius: 12, padding: 32, minWidth: 360, maxWidth: 420,
        boxShadow: "0 8px 32px rgba(0,0,0,0.2)", textAlign: "center",
      }}>
        <div style={{ fontSize: 48, marginBottom: 8 }}>📝</div>
        <h2 style={{ margin: "0 0 4px", fontSize: 22 }}>NoteForge</h2>
        <p style={{ color: "#666", fontSize: 14, margin: "0 0 16px" }}>
          本地优先 Markdown 知识管理桌面应用
        </p>
        <table style={{ margin: "0 auto", fontSize: 13, textAlign: "left" }}>
          <tbody>
            <tr><td style={{ padding: "4px 12px", color: "#999" }}>版本</td><td>{version}</td></tr>
            <tr><td style={{ padding: "4px 12px", color: "#999" }}>构建</td><td>{build}</td></tr>
            <tr><td style={{ padding: "4px 12px", color: "#999" }}>框架</td><td>Tauri 2 + React + TypeScript</td></tr>
            <tr><td style={{ padding: "4px 12px", color: "#999" }}>后端</td><td>Rust (11 crates)</td></tr>
          </tbody>
        </table>
        <button onClick={onClose} style={{
          marginTop: 20, padding: "8px 32px", border: "none", borderRadius: 6,
          background: "#2563eb", color: "white", fontSize: 14, cursor: "pointer",
        }}>确定</button>
      </div>
    </div>
  );
}
