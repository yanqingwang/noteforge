/**
 * 原生 HTML 查看器（参照 html-effectiveness 插件的 HEHTMLView 单文件 HTML 方案）。
 *
 * - 预览：完整文档（含 head/style）渲染于 sandbox iframe；src/href 与 CSS url()
 *   中的相对路径改写为 data URL —— 图片/字体走 read_file_data，
 *   css/js/html 走 read_file + base64，避免依赖 asset 协议与路径基准问题。
 * - 编辑：textarea 源码编辑，Ctrl+S / 保存按钮写回 vault，切回预览即时生效。
 * - 缩放：工具栏 − / % / + / ↺（与 HE 插件查看器一致），加载后按内容宽度自适应。
 */
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface HtmlViewerProps {
  /** vault 内相对路径（以 .html/.htm 结尾） */
  filePath: string;
  /** 状态栏回调（保存/失败提示） */
  onStatus?: (msg: string) => void;
}

const SKIP_URL = /^(?:[a-z][a-z0-9+.\-]*:|#)/i; // http(s)/data/asset/app/mailto/锚点等一律不动
const IMAGE_RE = /\.(?:png|jpe?g|gif|svg|webp|ico|bmp|avif)$/i;
const FONT_RE = /\.(?:woff2?|ttf|otf|eot)$/i;
const CSS_RE = /\.css$/i;
const JS_RE = /\.m?js$/i;
const HTML_RE = /\.html?$/i;

/**
 * 把 HTML 中的相对 URL 解析为 vault 内相对路径。
 * "/x" 视为 vault 根相对；"../" 正常回退；外链/锚点/data 等返回 null。
 */
export function resolveVaultPath(url: string | undefined, fileDir: string): string | null {
  const u = (url ?? "").trim();
  if (!u || SKIP_URL.test(u)) return null;
  const joined = u.startsWith("/") ? u.slice(1) : fileDir ? `${fileDir}/${u}` : u;
  const out: string[] = [];
  for (const seg of joined.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/") || null;
}

/** UTF-8 文本 → data URL（分块避免超大字符串展开栈） */
function textToDataUrl(text: string, mime: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${mime};base64,${btoa(bin)}`;
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : "";
}

/** 按扩展名加载资源为 data URL；不认识的类型返回 null（保持原 URL） */
async function loadDataUrl(rel: string): Promise<string | null> {
  const lower = rel.toLowerCase();
  try {
    if (IMAGE_RE.test(lower) || FONT_RE.test(lower)) {
      return await invoke<string>("read_file_data", { path: rel });
    }
    if (CSS_RE.test(lower)) {
      return textToDataUrl(await invoke<string>("read_file", { path: rel }), "text/css;charset=utf-8");
    }
    if (JS_RE.test(lower)) {
      return textToDataUrl(await invoke<string>("read_file", { path: rel }), "text/javascript;charset=utf-8");
    }
    if (HTML_RE.test(lower)) {
      return textToDataUrl(await invoke<string>("read_file", { path: rel }), "text/html;charset=utf-8");
    }
  } catch {
    /* 单个资源读不到时保持原样，不阻塞整页渲染 */
  }
  return null;
}

/**
 * 重写 HTML 中的相对路径引用为 data URL。
 * 覆盖 src/href 属性与 CSS url(...)（内联 style 与 <style> 均在全文中处理）。
 * 外链、锚点、data: 保持不变；同一资源只加载一次。
 */
export async function rewriteHtml(html: string, fileDir: string): Promise<string> {
  const attrRe = /\b(src|href)(\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi;
  const urlRe = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")]+))\s*\)/gi;

  const rels = new Set<string>();
  for (const m of html.matchAll(attrRe)) {
    const rel = resolveVaultPath(m[3] ?? m[4], fileDir);
    if (rel) rels.add(rel);
  }
  for (const m of html.matchAll(urlRe)) {
    const rel = resolveVaultPath(m[1] ?? m[2] ?? m[3], fileDir);
    if (rel) rels.add(rel);
  }
  if (rels.size === 0) return html;

  const resolved = new Map<string, string>();
  await Promise.all(
    [...rels].map(async (rel) => {
      const url = await loadDataUrl(rel);
      if (url) resolved.set(rel, url);
    }),
  );

  const out1 = html.replace(attrRe, (full, attr, eq, dq, sq) => {
    const rel = resolveVaultPath(dq ?? sq, fileDir);
    const repl = rel ? resolved.get(rel) : undefined;
    return repl ? `${attr}${eq}"${repl}"` : full;
  });
  return out1.replace(urlRe, (full, dq, sq, bare) => {
    const rel = resolveVaultPath(dq ?? sq ?? bare, fileDir);
    const repl = rel ? resolved.get(rel) : undefined;
    return repl ? `url("${repl}")` : full;
  });
}

const HtmlViewer = memo(function HtmlViewer({ filePath, onStatus }: HtmlViewerProps) {
  const [mode, setMode] = useState<"preview" | "edit">("preview");
  const [raw, setRaw] = useState("");
  const [rendered, setRendered] = useState("");
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [errMsg, setErrMsg] = useState("");
  const [dirty, setDirty] = useState(false);
  const [zoom, setZoom] = useState(1);
  const userZoomed = useRef(false);
  const seq = useRef(0);
  // 最新回调的 ref 镜像：避免父组件每次渲染都触发重新加载
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;

  const build = useCallback(
    async (text: string) => {
      const my = ++seq.current;
      const out = await rewriteHtml(text, dirOf(filePath));
      if (my === seq.current) {
        setRendered(out);
        setPhase("ready");
      }
    },
    [filePath],
  );

  // 打开文件：读原文 → 生成预览
  useEffect(() => {
    let alive = true;
    setMode("preview");
    setDirty(false);
    setZoom(1);
    userZoomed.current = false;
    setPhase("loading");
    setErrMsg("");
    invoke<string>("read_file", { path: filePath })
      .then((t) => {
        if (!alive) return;
        setRaw(t);
        return build(t);
      })
      .catch((e) => {
        if (!alive) return;
        setErrMsg(String(e));
        setPhase("error");
        onStatusRef.current?.(`❌ 打开失败: ${filePath}`);
      });
    return () => {
      alive = false;
    };
  }, [filePath, build]);

  const save = useCallback(async () => {
    try {
      await invoke("write_note", { notePath: filePath, content: raw });
      setDirty(false);
      onStatus?.(`✅ 已保存: ${filePath}`);
      await build(raw);
    } catch (e) {
      onStatus?.(`❌ 保存失败: ${e}`);
    }
  }, [filePath, raw, build, onStatus]);

  const toggleMode = () => {
    if (mode === "preview") {
      setMode("edit");
    } else {
      setMode("preview");
      if (dirty) void build(raw); // 未保存的编辑也先按最新内容预览
    }
  };

  const applyZoom = (z: number) => {
    userZoomed.current = true;
    setZoom(Math.min(3, Math.max(0.3, z)));
  };

  // 预览加载后按内容宽度自适应（未手动缩放时）
  const onIframeLoad = (e: React.SyntheticEvent<HTMLIFrameElement>) => {
    if (userZoomed.current) return;
    try {
      const doc = e.currentTarget.contentDocument;
      const w = doc?.documentElement?.scrollWidth || 0;
      const vw = e.currentTarget.clientWidth || 1;
      if (w > vw + 4) setZoom(Math.max(0.3, vw / w));
    } catch {
      /* jsdom/沙箱下不可访问时忽略 */
    }
  };

  const btn: React.CSSProperties = {
    padding: "2px 8px", border: "1px solid #ddd", borderRadius: 3, cursor: "pointer",
    background: "#fff", fontSize: 12, color: "#555",
  };

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, overflow: "hidden" }}>
      {/* 工具栏 */}
      <div style={{ display: "flex", alignItems: "center", padding: "4px 8px", gap: 4,
        background: "#f8f8f8", borderBottom: "1px solid #eee", fontSize: 12 }}>
        <button onClick={toggleMode} style={{ ...btn, fontWeight: 600 }}>
          {mode === "preview" ? "✏️ 编辑" : "👁 预览"}
        </button>
        {mode === "edit" && (
          <button onClick={save} style={{ ...btn, fontWeight: 600 }}>💾 保存 (Ctrl+S)</button>
        )}
        {dirty && <span style={{ color: "#b45309" }}>● 未保存</span>}
        <div style={{ flex: 1 }} />
        <span style={{ color: "#999" }}>🔍</span>
        <button onClick={() => applyZoom(zoom - 0.1)} style={btn}>−</button>
        <span style={{ minWidth: 40, textAlign: "center", color: "#666" }}>{Math.round(zoom * 100)}%</span>
        <button onClick={() => applyZoom(zoom + 0.1)} style={btn}>+</button>
        <button onClick={() => { userZoomed.current = false; setZoom(1); }} style={btn}>↺</button>
      </div>

      {/* 主体 */}
      {mode === "edit" ? (
        <textarea
          value={raw}
          spellCheck={false}
          onChange={(e) => { setRaw(e.target.value); setDirty(true); }}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
              e.preventDefault();
              e.stopPropagation();
              void save();
            }
          }}
          style={{
            flex: 1, width: "100%", boxSizing: "border-box", border: "none", outline: "none",
            resize: "none", padding: 12, fontSize: 13, lineHeight: 1.6,
            fontFamily: "ui-monospace, Menlo, Consolas, monospace",
            background: "#fff", color: "#24292f",
          }}
        />
      ) : (
        <div style={{ flex: 1, overflow: "hidden", background: "#fff" }}>
          {phase === "loading" && (
            <p style={{ padding: 16, color: "#999" }}>加载中...</p>
          )}
          {phase === "error" && (
            <p style={{ padding: 16, color: "red" }}>加载失败: {errMsg}</p>
          )}
          {phase === "ready" && (
            <iframe
              title={filePath}
              sandbox="allow-scripts allow-same-origin"
              srcDoc={rendered}
              onLoad={onIframeLoad}
              style={{
                width: `${100 / zoom}%`,
                height: `${100 / zoom}%`,
                transform: `scale(${zoom})`,
                transformOrigin: "top left",
                border: "none",
                display: "block",
              }}
            />
          )}
        </div>
      )}
    </div>
  );
});

export default HtmlViewer;
