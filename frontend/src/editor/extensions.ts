/**
 * CM6 编辑扩展包：列表续行、自动配对、格式快捷键、粘贴/拖拽图片、
 * wikilink 自动补全、编辑器主题。
 */
import { EditorView, keymap } from "@codemirror/view";
import { EditorSelection } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { autocompletion, closeBrackets } from "@codemirror/autocomplete";
import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { livePreview } from "./livePreview";

// ── 列表续行（ED-05）────────────────────────────────────────────────

const LIST_RE = /^(\s*)([-*+]\s\[( |x|X)\]\s|[-*+]\s|(\d+)([.)])\s|>\s?)/;

/** 回车：续行列表/引用/任务；空项回车取消列表。 */
function listContinue(view: EditorView): boolean {
  const { state } = view;
  const changes: { from: number; to: number; insert: string }[] = [];
  let matched = false;
  for (const range of state.selection.ranges) {
    if (!range.empty) continue;
    const line = state.doc.lineAt(range.head);
    const m = line.text.match(LIST_RE);
    if (!m) continue;
    matched = true;
    const marker = m[2] ?? (m[4] !== undefined ? `${m[4]}${m[5]} ` : "");
    const rest = line.text.slice(m[0].length);
    // 空项回车 → 清掉列表标记
    if (rest.trim() === "") {
      changes.push({ from: line.from, to: line.to, insert: m[1] });
      continue;
    }
    // 任务列表续行为 `- [ ] `；有序列表数字 +1
    let nextMarker = marker;
    const taskMatch = marker.match(/^([-*+]\s)\[( |x|X)\]\s$/);
    if (taskMatch) nextMarker = `${taskMatch[1]}[ ] `;
    const olMatch = marker.match(/^(\d+)([.)])\s$/);
    if (olMatch) nextMarker = `${parseInt(olMatch[1]) + 1}${olMatch[2]} `;
    changes.push({ from: range.head, to: range.head, insert: "\n" + m[1] + nextMarker });
  }
  if (!matched) return false;
  view.dispatch({ changes });
  return true;
}

// ── 格式化快捷键（ED-04）────────────────────────────────────────────

/** 将选区（或光标词）包裹为 inline 标记；无选区时插入标记并让光标居中 */
function toggleWrap(view: EditorView, mark: string, placeholder = "文本"): boolean {
  const { state } = view;
  const changes: { from: number; to: number; insert: string }[] = [];
  const cursors: number[] = [];
  const m = mark.length;
  for (const range of state.selection.ranges) {
    const text = state.sliceDoc(range.from, range.to);
    const before = state.sliceDoc(Math.max(0, range.from - m), range.from);
    const after = state.sliceDoc(range.to, Math.min(state.doc.length, range.to + m));
    if (text.startsWith(mark) && text.endsWith(mark) && text.length >= m * 2) {
      // 已包裹 → 取消
      changes.push({ from: range.from, to: range.to, insert: text.slice(m, -m) });
      cursors.push(range.from + text.length - m * 2);
    } else if (before === mark && after === mark && range.empty) {
      // 光标在标记内 → 取消
      changes.push({ from: range.from - m, to: range.from, insert: "" });
      changes.push({ from: range.to, to: range.to + m, insert: "" });
      cursors.push(range.from - m);
    } else if (range.empty) {
      changes.push({ from: range.from, to: range.to, insert: `${mark}${placeholder}${mark}` });
      cursors.push(range.from + m);
    } else {
      changes.push({ from: range.from, to: range.to, insert: `${mark}${text}${mark}` });
      cursors.push(range.from + text.length + m * 2);
    }
  }
  view.dispatch({
    changes,
    selection: EditorSelection.create(cursors.map(c => EditorSelection.cursor(c))),
    scrollIntoView: true,
  });
  return true;
}

/** 行前缀切换（标题/引用/无序列表）；prefix=null 清除 */
function linePrefix(view: EditorView, prefix: string | null): boolean {
  const { state } = view;
  const changes: { from: number; to: number; insert: string }[] = [];
  const lines = new Set<number>();
  for (const range of state.selection.ranges) {
    const a = state.doc.lineAt(range.from).number;
    const b = state.doc.lineAt(range.to).number;
    for (let l = a; l <= b; l++) lines.add(l);
  }
  for (const l of lines) {
    const line = state.doc.line(l);
    const existing = line.text.match(/^(#{1,6}\s|>\s|- |\d+\. )/)?.[0];
    if (prefix === null) {
      if (existing) changes.push({ from: line.from, to: line.from + existing.length, insert: "" });
    } else if (existing === prefix) {
      changes.push({ from: line.from, to: line.from + existing.length, insert: "" });
    } else {
      if (existing) changes.push({ from: line.from, to: line.from + existing.length, insert: "" });
      changes.push({ from: line.from, to: line.from, insert: prefix });
    }
  }
  view.dispatch({ changes, scrollIntoView: true });
  return true;
}

function codeBlock(view: EditorView): boolean {
  const { state } = view;
  const range = state.selection.main;
  const line = state.doc.lineAt(range.from);
  const needsNl = line.from !== range.from || !line.text.trim();
  const insert = (needsNl ? "\n" : "") + "```\n\n```";
  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection: { anchor: range.from + insert.length - 3 },
    scrollIntoView: true,
  });
  return true;
}

function insertLink(view: EditorView): boolean {
  const { state } = view;
  const range = state.selection.main;
  const text = state.sliceDoc(range.from, range.to) || "链接文本";
  const insert = `[${text}](url)`;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection: EditorSelection.range(range.from + text.length + 3, range.from + insert.length - 1),
    scrollIntoView: true,
  });
  return true;
}

// ── 粘贴/拖拽图片（ED-07）───────────────────────────────────────────

function attachmentsPath(): string {
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const pad = (n: number) => String(n).padStart(2, "0");
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `attachments/${ym}/${ts}`;
}

async function saveImage(view: EditorView, file: File, pos?: number): Promise<void> {
  const ext = (file.name.match(/\.(\w+)$/)?.[1] || file.type.split("/")[1] || "png").toLowerCase();
  const rel = `${attachmentsPath()}.${ext}`;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const data = Array.from(new Uint8Array(await file.arrayBuffer()));
    await invoke("write_attachment", { path: rel, data });
    const insertText = `![[${rel}]]`;
    const p = pos ?? view.state.selection.main.head;
    view.dispatch({ changes: { from: p, insert: insertText }, selection: { anchor: p + insertText.length } });
  } catch (e) {
    console.error("保存图片失败", e);
  }
}

function pasteImageHandler(view: EditorView, event: ClipboardEvent): boolean {
  const files = Array.from(event.clipboardData?.files ?? []).filter(f => f.type.startsWith("image/"));
  if (files.length === 0) return false;
  event.preventDefault();
  files.forEach(f => saveImage(view, f));
  return true;
}

function dropImageHandler(view: EditorView, event: DragEvent): boolean {
  const files = Array.from(event.dataTransfer?.files ?? []).filter(f => f.type.startsWith("image/"));
  if (files.length === 0) return false;
  event.preventDefault();
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
  files.forEach(f => saveImage(view, f, pos ?? undefined));
  return true;
}

// ── wikilink 自动补全（ED-08）───────────────────────────────────────

function makeWikilinkSource(getFiles: () => string[]) {
  return (context: CompletionContext): CompletionResult | null => {
    const before = context.matchBefore(/\[\[([^\]\n|]*)/);
    if (!before) return null;
    const filter = before.text.slice(2);
    const files = getFiles()
      .filter(f => f.toLowerCase().includes(filter.toLowerCase()))
      .slice(0, 30)
      .map(f => ({
        label: f,
        type: "file",
        apply: `[[${f}]]`,
      }));
    return { from: before.from + 2, options: files, validFor: /^[^\]\n|]*$/ };
  };
}

// ── 主题 ────────────────────────────────────────────────────────────

export const nfTheme = EditorView.theme({
  "&": { fontSize: "14px", backgroundColor: "#fefefe" },
  ".cm-scroller": {
    fontFamily: '"SF Mono", "Fira Code", "Cascadia Code", Consolas, monospace',
    lineHeight: "1.7",
    padding: "12px 16px",
  },
  ".cm-content": { caretColor: "#222" },
  ".cm-gutters": { backgroundColor: "#fafafa", color: "#bbb", border: "none" },
  ".cm-activeLine": { backgroundColor: "rgba(0,0,0,0.03)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "#666" },
  // Live preview 视觉
  ".lp-heading": { fontWeight: 600 },
  ".lp-h1": { fontSize: "1.9em", lineHeight: "1.4" },
  ".lp-h2": { fontSize: "1.6em", lineHeight: "1.4" },
  ".lp-h3": { fontSize: "1.35em" },
  ".lp-h4": { fontSize: "1.2em" },
  ".lp-h5": { fontSize: "1.1em" },
  ".lp-h6": { fontSize: "1em", color: "#666" },
  ".lp-bold": { fontWeight: 700 },
  ".lp-italic": { fontStyle: "italic" },
  ".lp-del": { textDecoration: "line-through", color: "#999" },
  ".lp-inline-code": {
    background: "#f0f1f3", borderRadius: "4px",
    padding: "1px 4px", color: "#cf222e", fontSize: "0.92em",
  },
  ".lp-mark": { color: "#b3b3b3" },
  ".lp-quote": { borderLeft: "3px solid #d0d7de", paddingLeft: "10px", color: "#57606a" },
  ".lp-codeline": { background: "#f6f8fa" },
  ".lp-codeblock": {
    background: "#f6f8fa", borderRadius: "6px", padding: "10px 12px",
    margin: "4px 0", fontSize: "0.92em", overflowX: "auto", display: "block",
  },
  ".lp-tableline": { fontFamily: '"SF Mono", Consolas, monospace', fontSize: "0.95em" },
  ".lp-link": { color: "#0969da", textDecoration: "underline" },
  ".lp-wikilink": {
    color: "#0969da", background: "#ddf4ff", borderRadius: "3px",
    padding: "1px 4px", cursor: "pointer",
  },
  ".lp-wikilink:hover": { background: "#b6e0ff", textDecoration: "underline" },
  ".lp-embed-image": { display: "block", margin: "6px 0" },
  ".lp-task-checkbox": { marginRight: "4px", cursor: "pointer" },
});

// ── 汇总 ────────────────────────────────────────────────────────────

export interface EditorExtOptions {
  /** live 模式：启用 Live Preview 装饰 */
  live: boolean;
  /** 是否显示行号（source/split 模式） */
  lineNumbers: boolean;
  /** wikilink 补全文件列表 */
  getFiles: () => string[];
  /** 追加 keymap（Ctrl+S 等，优先级更高） */
  extraKeys?: any[];
}

export function nfExtensions(opts: EditorExtOptions): Extension[] {
  return [
    nfTheme,
    ...(opts.live ? [livePreview()] : []),
    autocompletion({ override: [makeWikilinkSource(opts.getFiles)] }),
    closeBrackets(),
    EditorView.domEventHandlers({
      paste: pasteImageHandler as any,
      drop: dropImageHandler as any,
    }),
    keymap.of([
      ...(opts.extraKeys ?? []),
      { key: "Enter", run: listContinue },
      { key: "Mod-b", run: (v) => toggleWrap(v, "**") },
      { key: "Mod-i", run: (v) => toggleWrap(v, "*") },
      { key: "Mod-Shift-x", run: (v) => toggleWrap(v, "~~") },
      { key: "Mod-e", run: (v) => toggleWrap(v, "`") },
      { key: "Mod-k", run: insertLink },
      { key: "Mod-Shift-k", run: codeBlock },
      { key: "Mod-1", run: (v) => linePrefix(v, "# ") },
      { key: "Mod-2", run: (v) => linePrefix(v, "## ") },
      { key: "Mod-3", run: (v) => linePrefix(v, "### ") },
      { key: "Mod-4", run: (v) => linePrefix(v, "#### ") },
      { key: "Mod-5", run: (v) => linePrefix(v, "##### ") },
      { key: "Mod-6", run: (v) => linePrefix(v, "###### ") },
      { key: "Mod-Shift-8", run: (v) => linePrefix(v, "- ") },
      { key: "Mod-Shift-.", run: (v) => linePrefix(v, "> ") },
      { key: "Mod-0", run: (v) => linePrefix(v, null) },
    ]),
  ];
}
