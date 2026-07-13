import { useEffect, useRef, useState, useCallback, memo } from "react";
import hljs from "highlight.js";
import "highlight.js/styles/github.css";
import WikilinkAutocomplete from "./WikilinkAutocomplete";
import { pluginManager } from "../plugins/PluginManager";

type ViewMode = "source" | "preview" | "split" | "live";

interface EditorPaneProps {
  content: string;
  previewHtml: string;
  activeFile: string;
  files?: { path: string }[];
  onNavigate?: (path: string) => void;
  mode?: ViewMode;
  onSetMode?: (m: ViewMode) => void;
}

export type { ViewMode };

function mdToHtml(md: string): string {
  let html = md
    // ![[image.png]] embedded image via wikilink
    .replace(/!\[\[([^\]]+)\]\]/g, (_, target) => {
      const t = target.split('|')[0];
      if (/\.(png|jpg|jpeg|gif|svg|webp|bmp|ico)$/i.test(t))
        return `<img src="note://${t}" alt="${t}" style="max-width:100%" />`;
      return `<a href="note://${t}">${t}</a>`;
    })
    // [[target|display]] wikilink
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, display) =>
      `<a href="note://${target}" class="wikilink">${display || target}</a>`)
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" style="max-width:100%"/>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>').replace(/^## (.+)$/gm, '<h2>$1</h2>').replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/~~(.+?)~~/g, '<del>$1</del>').replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/^\- (.+)$/gm, '<li>$1</li>').replace(/^(\d+)\. (.+)$/gm, '<li>$2</li>')
    .replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>')
    .replace(/\n\n/g, '</p><p>');
  return '<p>' + html + '</p>';
}

/** Highlight wikilinks & formatting in source for overlay display */
function highlightSource(text: string): string {
  return text
    .replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/(\[\[[^\]]+\]\])/g, '<span class="hl-wikilink">$1</span>')
    .replace(/(#{1,6}\s.+)/g, '<span class="hl-heading">$1</span>')
    .replace(/(\*\*.+?\*\*)/g, '<span class="hl-bold">$1</span>')
    .replace(/(\*.+?\*)/g, '<span class="hl-italic">$1</span>')
    .replace(/(`[^`]+`)/g, '<span class="hl-code">$1</span>')
    .replace(/(~~.+?~~)/g, '<span class="hl-del">$1</span>')
    .replace(/(\[.+\]\([^)]+\))/g, '<span class="hl-link">$1</span>');
}

const EditorPane = memo(function EditorPane({ content, previewHtml, activeFile, files = [], onNavigate, mode: externalMode, onSetMode: externalSetMode }: EditorPaneProps) {
  const [internalMode, internalSetMode] = useState<ViewMode>(() => {
    const saved = localStorage.getItem('nf-view-mode');
    return (saved === "source" || saved === "preview" || saved === "split" || saved === "live") ? saved : "split";
  });
  const mode = externalMode ?? internalMode;
  const setMode = externalSetMode ?? internalSetMode;
  // Persist view mode to localStorage when using internal state
  useEffect(() => { if (!externalMode) localStorage.setItem('nf-view-mode', mode); }, [mode, externalMode]);
  const [editContent, setEditContent] = useState(content);
  const [autocomplete, setAutocomplete] = useState<{ rect: DOMRect; filter: string } | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef<HTMLDivElement>(null);
  const [liveHtml, setLiveHtml] = useState(previewHtml);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lineNumRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const syncing = useRef(false);

  useEffect(() => { setEditContent(content); setLiveHtml(previewHtml); }, [content, previewHtml]);

  useEffect(() => {
    if (editContent === content) return;
    if (mode === "live") {
      setLiveHtml(mdToHtml(editContent));
    } else {
      const t = setTimeout(() => setLiveHtml(mdToHtml(editContent)), 150);
      return () => clearTimeout(t);
    }
  }, [editContent, content, mode]);

  // Sync textarea ↔ overlay ↔ preview scroll
  const handleScroll = useCallback(() => {
    if (syncing.current) return;
    const ta = textareaRef.current;
    if (!ta) return;
    if (lineNumRef.current) lineNumRef.current.scrollTop = ta.scrollTop;
    if (overlayRef.current) overlayRef.current.scrollTop = ta.scrollTop;
    if (mode !== "split") return;
    const pr = previewRef.current;
    if (!pr) return;
    const pct = ta.scrollHeight > ta.clientHeight ? ta.scrollTop / (ta.scrollHeight - ta.clientHeight) : 0;
    syncing.current = true;
    pr.scrollTop = pct * (pr.scrollHeight - pr.clientHeight);
    syncing.current = false;
  }, [mode]);

  // Sync preview → source scroll (split mode)
  const handlePreviewScroll = useCallback(() => {
    if (syncing.current || mode !== "split") return;
    const pr = previewRef.current;
    const ta = textareaRef.current;
    if (!pr || !ta) return;
    const pct = pr.scrollHeight > pr.clientHeight ? pr.scrollTop / (pr.scrollHeight - pr.clientHeight) : 0;
    syncing.current = true;
    ta.scrollTop = pct * (ta.scrollHeight - ta.clientHeight);
    syncing.current = false;
  }, [mode]);

  // Cursor preservation for live mode
  const saveCursor = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !liveRef.current) return null;
    const range = sel.getRangeAt(0);
    const pre = document.createRange();
    pre.selectNodeContents(liveRef.current);
    pre.setEnd(range.startContainer, range.startOffset);
    return pre.toString().length;
  }, []);

  const restoreCursor = useCallback((pos: number | null) => {
    if (pos === null || !liveRef.current) return;
    const sel = window.getSelection();
    if (!sel) return;
    const walker = document.createTreeWalker(liveRef.current, NodeFilter.SHOW_TEXT);
    let current = 0;
    let node;
    while ((node = walker.nextNode())) {
      const len = node.textContent?.length || 0;
      if (current + len >= pos) {
        const offset = pos - current;
        const range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, offset);
        sel.removeAllRanges();
        sel.addRange(range);
        return;
      }
      current += len;
    }
  }, []);

  // Handle input in live mode
  const handleLiveInput = useCallback(() => {
    if (!liveRef.current) return;
    const html = liveRef.current.innerHTML;
    const md = html
      .replace(/<h1[^>]*>/g, '# ').replace(/<\/h1>/g, '\n\n')
      .replace(/<h2[^>]*>/g, '## ').replace(/<\/h2>/g, '\n\n').replace(/<h3[^>]*>/g, '### ').replace(/<\/h3>/g, '\n\n')
      .replace(/<strong>/g, '**').replace(/<\/strong>/g, '**')
      .replace(/<em>/g, '*').replace(/<\/em>/g, '*')
      .replace(/<code>/g, '\`').replace(/<\/code>/g, '\`')
      .replace(/<li[^>]*>/g, '- ').replace(/<\/li>/g, '\n')
      .replace(/<blockquote>/g, '> ').replace(/<\/blockquote>/g, '\n')
      .replace(/<p>/g, '').replace(/<\/p>/g, '\n\n')
      .replace(/<br\s*\/?>/g, '\n').replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/<[^>]*>/g, '');
    setEditContent(md);
  }, []);

  // Re-render live mode from markdown, preserving cursor
  useEffect(() => {
    if (mode !== "live" || !liveRef.current) return;
    if (editContent === content && previewHtml) {
      liveRef.current.innerHTML = previewHtml;
      return;
    }
    const pos = saveCursor();
    liveRef.current.innerHTML = liveHtml;
    restoreCursor(pos);
  }, [liveHtml, mode, previewHtml, content, editContent]);

  // Wikilink click → navigate
  useEffect(() => {
    if (!onNavigate) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'A' && t.getAttribute('href')?.startsWith('note://')) {
        e.preventDefault(); onNavigate(t.getAttribute('href')!.replace('note://', ''));
      }
    };
    const el1 = previewRef.current, el2 = liveRef.current;
    el1?.addEventListener('click', handler);
    el2?.addEventListener('click', handler);
    return () => { el1?.removeEventListener('click', handler); el2?.removeEventListener('click', handler); };
  }, [previewHtml, liveHtml, onNavigate, mode]);

  // Syntax highlighting in preview
  useEffect(() => {
    if (!previewRef.current) return;
    // Add wikilink class to all note:// links (from Rust renderer or manual markdown)
    previewRef.current.querySelectorAll('a[href^="note://"]').forEach(a => a.classList.add('wikilink'));
    previewRef.current.querySelectorAll('pre code').forEach(b => hljs.highlightElement(b as HTMLElement));
  }, [previewHtml, mode]);

  // Plugin markdown post-processors (html-effect etc.)
  useEffect(() => {
    const el = mode === "preview" || mode === "split" ? previewRef.current : null;
    if (!el) return;
    for (const [lang, processor] of pluginManager.getPostProcessors()) {
      el.querySelectorAll(`pre > code.language-${CSS.escape(lang)}`).forEach(code => {
        const pre = code.parentElement;
        if (!pre || pre.dataset.heProcessed) return;
        pre.dataset.heProcessed = "true";
        const source = code.textContent || "";
        const container = document.createElement("div");
        container.className = "he-container";
        pre.parentNode?.replaceChild(container, pre);
        processor(source, container);
      });
    }
  }, [previewHtml, mode]);

  // Source input handler + [[ autocomplete
  const handleSourceChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setEditContent(val);
    const pos = e.target.selectionStart;
    const before = val.slice(0, pos);
    const lastOpen = before.lastIndexOf('[[');
    const lastClose = before.lastIndexOf(']]');
    if (lastOpen > lastClose && lastOpen >= 0) {
      const filter = before.slice(lastOpen + 2);
      const ta = e.target;
      const rect = ta.getBoundingClientRect();
      const lines = before.slice(0, pos).split('\n');
      const top = rect.top + (lines.length - 1) * 18 + 38;
      setAutocomplete({ rect: new DOMRect(rect.left + 16, top, 0, 0), filter });
    } else {
      setAutocomplete(null);
    }
  }, []);

  const handleAutocompleteSelect = useCallback((path: string) => {
    if (!textareaRef.current) return;
    const ta = textareaRef.current;
    const pos = ta.selectionStart;
    const before = ta.value.slice(0, pos);
    const lastOpen = before.lastIndexOf('[[');
    if (lastOpen >= 0) {
      const newContent = ta.value.slice(0, lastOpen) + `[[${path}]]` + ta.value.slice(pos);
      setEditContent(newContent);
      setAutocomplete(null);
      setTimeout(() => { ta.focus(); ta.selectionStart = ta.selectionEnd = lastOpen + path.length + 4; }, 0);
    }
  }, []);

  // Live mode: Typora-like WYSIWYG via contentEditable with cursor preservation
  if (!activeFile) {
    return <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#999" }}><p>选择笔记查看内容</p></div>;
  }

  const currentHtml = editContent !== content ? liveHtml : previewHtml;
  const lines = editContent.split('\n');
  const textareaStyle: React.CSSProperties = {
    flex: 1, padding: "12px 16px", border: "none", outline: "none", resize: "none",
    fontFamily: '"SF Mono", "Fira Code", "Cascadia Code", Consolas, monospace',
    fontSize: 14, lineHeight: 1.6, color: "transparent", caretColor: "#222",
    background: "transparent", tabSize: 4, whiteSpace: "pre", overflowWrap: "normal",
    position: "absolute", top: 0, left: 0, right: 0, bottom: 0, zIndex: 2,
  };

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
      {/* Tab bar */}
      <div style={{ display: "flex", alignItems: "center", padding: "4px 8px", background: "#f8f8f8", borderBottom: "1px solid #eee", gap: 4 }}>
        <span style={{ flex: 1, fontSize: 13, color: "#666" }}>📄 {activeFile}</span>
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
        {/* Source mode - line numbers + overlay + textarea */}
        {(mode === "source" || mode === "split") && (
          <div style={{ flex: 1, display: "flex", overflow: "hidden", background: "#fefefe" }}>
            {/* Line numbers */}
            <div ref={lineNumRef} style={{ padding: "12px 8px", textAlign: "right", color: "#999", fontSize: 12,
              fontFamily: '"SF Mono", Consolas, monospace', lineHeight: 1.6, overflow: "hidden",
              userSelect: "none", minWidth: 42, borderRight: "1px solid #eee", background: "#fafafa" }}>
              {lines.map((_, i) => <div key={i}>{i + 1}</div>)}
            </div>
            {/* Wrapper: overlay behind textarea */}
            <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
              {/* Highlight overlay */}
              <div ref={overlayRef} style={{ padding: "12px 16px", whiteSpace: "pre", overflowWrap: "normal",
                fontFamily: '"SF Mono", "Fira Code", "Cascadia Code", Consolas, monospace',
                fontSize: 14, lineHeight: 1.6, overflow: "hidden", position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
                zIndex: 1, pointerEvents: "none" }}
                dangerouslySetInnerHTML={{ __html: highlightSource(editContent) + '\n' }} />
              {/* Transparent textarea */}
              <textarea ref={textareaRef} value={editContent} onChange={handleSourceChange}
                onScroll={handleScroll} onKeyUp={handleScroll}
                style={textareaStyle} spellCheck={false} />
            </div>
          </div>
        )}

        {/* Preview pane */}
        {(mode === "preview" || mode === "split") && (
          <div ref={previewRef} style={{
            width: mode === "split" ? "50%" : "100%",
            borderLeft: mode === "split" ? "1px solid #ddd" : "none",
            overflowY: "auto", padding: 16
          }} className="markdown-body" dangerouslySetInnerHTML={{ __html: currentHtml }}
            onScroll={handlePreviewScroll} />
        )}

        {/* Live mode: Typora-style WYSIWYG */}
        {mode === "live" && (
          <div ref={liveRef} contentEditable suppressContentEditableWarning onInput={handleLiveInput}
            style={{ flex: 1, padding: 16, overflowY: "auto", outline: "none",
              fontFamily: '"SF Mono", "Fira Code", Consolas, monospace', fontSize: 14, lineHeight: 1.8 }}
            className="markdown-body" />
        )}
      </div>

      {/* Wikilink autocomplete */}
      {autocomplete && files.length > 0 && (
        <WikilinkAutocomplete files={files} filter={autocomplete.filter}
          anchorRect={autocomplete.rect} onSelect={handleAutocompleteSelect} onClose={() => setAutocomplete(null)} />
      )}

      <style>{`
        .hl-wikilink { color: #0969da; background: #ddf4ff; border-radius: 3px; padding: 0 2px; }
        .hl-heading { color: #0550ae; font-weight: 600; }
        .hl-bold { color: #222; font-weight: 600; }
        .hl-italic { color: #444; font-style: italic; }
        .hl-code { color: #cf222e; background: #f6f8fa; border-radius: 3px; padding: 0 2px; font-size: 0.9em; }
        .hl-del { color: #999; text-decoration: line-through; }
        .hl-link { color: #0969da; }
        .markdown-body a.wikilink { color: #0969da; background: #ddf4ff; border-radius: 3px; padding: 1px 4px; text-decoration: none; }
        .markdown-body a.wikilink:hover { background: #b6e0ff; text-decoration: underline; }
      `}</style>
    </div>
  );
});

export default EditorPane;
