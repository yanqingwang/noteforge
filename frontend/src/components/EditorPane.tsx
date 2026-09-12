import { useEffect, useRef, useState, memo } from "react";
import { EditorView, keymap, lineNumbers as cmLineNumbers, highlightActiveLine, drawSelection, dropCursor } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches, search } from "@codemirror/search";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { nfExtensions } from "../editor/extensions";
import { editorBridge, EchoTracker } from "../editor/bridge";
import type { OutlineItem } from "../editor/bridge";
import { extractOutline } from "../editor/bridge";

type ViewMode = "source" | "preview" | "split" | "live";

interface EditorPaneProps {
  content: string;
  previewHtml: string;
  activeFile: string;
  files?: { path: string }[];
  onNavigate?: (path: string) => void;
  mode?: ViewMode;
  onSetMode?: (m: ViewMode) => void;
  onContentChange?: (content: string) => void;
  /** 自动保存 / 状态提示回调（可选） */
  onStatus?: (msg: string) => void;
  /** 文档大纲变化回调（M6 大纲面板） */
  onOutline?: (items: OutlineItem[]) => void;
  /** 亮/暗主题 */
  theme?: "light" | "dark";
}

export type { ViewMode };

const AUTO_SAVE_MS = 2000;

const EditorPane = memo(function EditorPane({
  content, previewHtml, activeFile, files = [], onNavigate, mode: externalMode, onSetMode, onContentChange, onStatus, onOutline, theme = "light",
}: EditorPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const liveComp = useRef(new Compartment());
  // 外部未传 mode 时的兜底内部状态
  const [internalMode, setInternalMode] = useState<ViewMode>(() => {
    const saved = localStorage.getItem('nf-view-mode');
    return (saved === "source" || saved === "preview" || saved === "split" || saved === "live") ? saved : "split";
  });
  const mode = externalMode ?? internalMode;
  const setMode = onSetMode ?? setInternalMode;

  // 最新 props 的 ref 镜像（避免重建 EditorView）
  const cbRef = useRef({ content, activeFile, onContentChange, onNavigate, onStatus, files, onOutline, theme });
  cbRef.current = { content, activeFile, onContentChange, onNavigate, onStatus, files, onOutline, theme };
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const dirtyRef = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // 编辑器 echo 指纹（乱序安全）：App 异步渲染回写的任何近期旧值都不回灌
  const echoTracker = useRef(new EchoTracker());
  // 当前已加载的文件（区分文件切换与同文件外部修改）
  const fileRef = useRef<string>("");

  const doSave = async () => {
    const view = viewRef.current;
    const file = cbRef.current.activeFile;
    if (!view || !file || !dirtyRef.current) return;
    try {
      await import("@tauri-apps/api/core").then(({ invoke }) =>
        invoke("write_note", { notePath: file, content: view.state.doc.toString() }));
      dirtyRef.current = false;
      cbRef.current.onStatus?.(`✅ 已保存: ${file}`);
    } catch (e) {
      cbRef.current.onStatus?.(`❌ 保存失败: ${e}`);
    }
  };

  const scheduleAutoSave = () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(doSave, AUTO_SAVE_MS);
  };

  const emitOutline = (docStr: string) => {
    cbRef.current.onOutline?.(extractOutline(docStr));
  };

  // ── 创建 EditorView（一次） ──
  useEffect(() => {
    if (!hostRef.current) return;
    const isLive = () => modeRef.current === "live";
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: cbRef.current.content || "",
        extensions: [
          markdown({ extensions: [GFM] }),
          history(),
          drawSelection(),
          dropCursor(),
          EditorView.lineWrapping,
          highlightActiveLine(),
          highlightSelectionMatches(),
          search(),
          cmLineNumbers(),
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
          // 可重组部分：live 装饰（含主题/快捷键/补全）
          liveComp.current.of(nfExtensions({
            live: isLive(), lineNumbers: !isLive(), getFiles: () => cbRef.current.files.map(f => f.path),
            theme: cbRef.current.theme,
          })),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) {
              dirtyRef.current = true;
              const docStr = u.state.doc.toString();
              echoTracker.current.mark(docStr);
              editorBridge.latestDoc = docStr;
              cbRef.current.onContentChange?.(docStr);
              emitOutline(docStr);
              scheduleAutoSave();
            }
          }),
          keymap.of([
            { key: "Mod-s", preventDefault: true, run: () => { doSave(); return true; } },
          ]),
        ],
      }),
    });
    viewRef.current = view;
    // 桥接：App 的保存按钮用最新文档，避免 React 缓存滞后
    editorBridge.requestSave = () => { doSave(); };
    // 注册大纲跳转监听
    const jumpListener = (item: OutlineItem) => {
      const v = viewRef.current;
      if (!v) return;
      const pos = Math.min(item.pos, v.state.doc.length);
      v.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
      v.focus();
    };
    editorBridge.jumpListeners.push(jumpListener);
    // 初始大纲
    emitOutline(view.state.doc.toString());
    return () => {
      view.destroy();
      viewRef.current = null;
      editorBridge.requestSave = null;
      editorBridge.jumpListeners = editorBridge.jumpListeners.filter(f => f !== jumpListener);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 模式切换：reconfigure live 装饰与行号 ──
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const isLive = mode === "live";
    view.dispatch({
      effects: liveComp.current.reconfigure(nfExtensions({
        live: isLive, lineNumbers: !isLive, getFiles: () => cbRef.current.files.map(f => f.path),
        theme: cbRef.current.theme,
      })),
    });
  }, [mode, theme]);

  // ── 外部内容变化（文件切换 / 缓存加载）→ 全文替换 ──
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const docStr = view.state.doc.toString();
    const isFileSwitch = activeFile !== fileRef.current;

    if (isFileSwitch) {
      // 真正的文件切换：加载外部内容
      fileRef.current = activeFile;
      echoTracker.current.reset(activeFile ? content : undefined);
      if (activeFile && docStr !== content) {
        view.dispatch({ changes: { from: 0, to: docStr.length, insert: content } });
      }
      editorBridge.latestDoc = content;
      editorBridge.activeFile = activeFile;
      emitOutline(content);
      dirtyRef.current = false;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      return;
    }

    // 同一文件：App 异步渲染的回写（含乱序到达的旧值）一律丢弃
    if (echoTracker.current.isEcho(content) || docStr === content) return;
    // 到这里才是同文件的真正外部修改（如磁盘重载）：允许覆盖
    view.dispatch({ changes: { from: 0, to: docStr.length, insert: content } });
    echoTracker.current.reset(content);
    editorBridge.latestDoc = content;
    emitOutline(content);
    dirtyRef.current = false;
    if (saveTimer.current) clearTimeout(saveTimer.current);
  }, [content, activeFile]);

  // ── wikilink / data-note 点击跳转（文档级委托，live 装饰与预览共用） ──
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const t = (e.target as HTMLElement).closest('[data-note]') as HTMLElement | null;
      if (t) {
        e.preventDefault();
        const path = t.getAttribute('data-note');
        if (path) cbRef.current.onNavigate?.(path);
      }
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, []);

  // ── split 模式滚动同步（编辑器 → 预览） ──
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const scroller = view.scrollDOM;
    let syncing = false;
    const onScroll = () => {
      if (syncing || modeRef.current !== "split") return;
      const pr = previewRef.current;
      if (!pr) return;
      const pct = scroller.scrollHeight > scroller.clientHeight
        ? scroller.scrollTop / (scroller.scrollHeight - scroller.clientHeight) : 0;
      syncing = true;
      pr.scrollTop = pct * (pr.scrollHeight - pr.clientHeight);
      syncing = false;
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, []);

  // ── preview/split 预览面板的代码高亮 ──
  useEffect(() => {
    if (!previewRef.current) return;
    previewRef.current.querySelectorAll('a[data-note]').forEach(a => a.classList.add('wikilink'));
  }, [previewHtml, mode]);

  // 组件卸载前保存
  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, []);

  // 预览模式隐藏编辑器后恢复时，让 CM6 重新测量尺寸
  useEffect(() => {
    if (mode !== "preview") viewRef.current?.requestMeasure();
  }, [mode]);

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
      {/* Tab bar */}
      <div style={{ display: "flex", alignItems: "center", padding: "4px 8px", background: "#f8f8f8", borderBottom: "1px solid #eee", gap: 4 }}>
        <span style={{ flex: 1, fontSize: 13, color: "#666" }}>📄 {activeFile || "未打开笔记"}</span>
        <div style={{ display: "flex", gap: 2, background: "#e8e8e8", borderRadius: 4, padding: 2 }}>
          {(["source", "split", "live", "preview"] as ViewMode[]).map(m => (
            <button key={m} onClick={() => setMode(m)}
              style={{ padding: "4px 10px", border: "none", borderRadius: 3, cursor: "pointer", fontSize: 12,
                background: mode === m ? "#fff" : "transparent", boxShadow: mode === m ? "0 1px 2px rgba(0,0,0,0.1)" : "none" }}>
              {m === "source" ? "源码" : m === "preview" ? "预览" : m === "live" ? "即输即显" : "分栏"}
            </button>
          ))}
        </div>
      </div>

      {/* Editor area */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden", position: "relative" }}>
        {/* 宿主 div 常驻：mode 切换只控制显隐，避免卸载导致 CM6 DOM 脱离文档 */}
        <div ref={hostRef} style={{
          flex: 1, minWidth: 0, overflow: "hidden",
          display: mode === "preview" ? "none" : "block",
        }} />
        {!activeFile && mode !== "preview" && (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center",
            justifyContent: "center", color: "#999", pointerEvents: "none", background: "#fefefe" }}>
            <p>选择笔记查看内容</p>
          </div>
        )}

        {/* Preview pane */}
        {(mode === "preview" || mode === "split") && (
          <div ref={previewRef} style={{
            width: mode === "split" ? "50%" : "100%",
            borderLeft: mode === "split" ? "1px solid #ddd" : "none",
            overflowY: "auto", padding: 16
          }} className="markdown-body"
            dangerouslySetInnerHTML={{ __html: previewHtml }} />
        )}
      </div>

      <style>{`
        .markdown-body a[data-note], .markdown-body a.wikilink {
          color: #0969da; background: #ddf4ff; border-radius: 3px; padding: 1px 4px; text-decoration: none; cursor: pointer;
        }
        .markdown-body a[data-note]:hover { background: #b6e0ff; text-decoration: underline; }
        .cm-editor { height: 100%; }
        .cm-editor.cm-focused { outline: none; }
      `}</style>
    </div>
  );
});

export default EditorPane;
