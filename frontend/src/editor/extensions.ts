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
import { tableEditing } from "./tableEdit";

// ── 列表续行（ED-05）────────────────────────────────────────────────

const LIST_RE = /^(\s*)([-*+]\s\[( |x|X)\]\s|[-*+]\s|(\d+)([.)])\s|>\s?)/;

/** 回车：续行列表/引用/任务；空项回车取消列表。（导出供测试） */
export function listContinue(view: EditorView): boolean {
  const { state } = view;
  const changes: { from: number; to: number; insert: string }[] = [];
  const cursors: number[] = [];
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
      cursors.push(line.from + m[1].length);
      continue;
    }
    // 任务列表续行为 `- [ ] `；有序列表数字 +1
    let nextMarker = marker;
    const taskMatch = marker.match(/^([-*+]\s)\[( |x|X)\]\s$/);
    if (taskMatch) nextMarker = `${taskMatch[1]}[ ] `;
    const olMatch = marker.match(/^(\d+)([.)])\s$/);
    if (olMatch) nextMarker = `${parseInt(olMatch[1]) + 1}${olMatch[2]} `;
    const insert = "\n" + m[1] + nextMarker;
    changes.push({ from: range.head, to: range.head, insert });
    // 光标置于新标记末尾
    cursors.push(range.head + insert.length);
  }
  if (!matched) return false;
  view.dispatch({
    changes,
    selection: EditorSelection.create(cursors.map(c => EditorSelection.cursor(c))),
    scrollIntoView: true,
  });
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
    if (before === mark && after === mark) {
      // 选区/光标在成对标记内 → 取消包裹
      changes.push({ from: range.from - m, to: range.from, insert: "" });
      changes.push({ from: range.to, to: range.to + m, insert: "" });
      cursors.push(range.from - m + text.length);
    } else if (text.startsWith(mark) && text.endsWith(mark) && text.length >= m * 2) {
      // 选区本身含标记 → 剥掉
      changes.push({ from: range.from, to: range.to, insert: text.slice(m, -m) });
      cursors.push(range.from + text.length - m * 2);
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

/** 图片/附件插入配置（对标 Obsidian「文件与链接」）。 */
export interface AttachConfig {
  /** vault 相对附件目录，如 "attachments"。 */
  dir: string;
  /** 是否放入 `YYYY-MM/` 子目录。 */
  subfolder: boolean;
  /** markdown 引用样式。 */
  linkStyle: "wikilink" | "markdown";
  /** 文件名方案。 */
  nameStyle: "timestamp" | "sequence";
  /** 链接路径写法。 */
  linkFormat: "absolute" | "relative" | "shortest";
  /** 粘贴的光栅图片是否转成 webp。 */
  convertWebp: boolean;
}

export const DEFAULT_ATTACH_CONFIG: AttachConfig = {
  dir: "attachments", subfolder: true, linkStyle: "wikilink",
  nameStyle: "timestamp", linkFormat: "absolute", convertWebp: false,
};

/** 本次会话已写入的附件相对路径，用于避免同毫秒/同名覆盖。 */
const usedNames = new Set<string>();

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * 生成附件的 vault 相对路径（纯函数，便于测试）。
 * - timestamp：`<dir>[/YYYY-MM]/YYYYMMDDHHmmss.ext`
 * - sequence： `<dir>[/YYYY-MM]/img-<epoch_ms>-<n>.ext`
 * 名称冲突时追加 `-1`/`-2`…（`sequence` 的 `n` 从 0 起递增）。
 */
export function buildAttachmentRel(
  cfg: Pick<AttachConfig, "dir" | "subfolder" | "nameStyle">,
  ext: string,
  now: Date,
  isTaken: (rel: string) => boolean,
): string {
  const dir = cfg.dir.trim().replace(/^\/+|\/+$/g, "") || "attachments";
  const ym = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`;
  const base = cfg.subfolder ? `${dir}/${ym}` : dir;
  if (cfg.nameStyle === "sequence") {
    const stem = `img-${now.getTime()}`;
    for (let n = 0; ; n++) {
      const rel = `${base}/${stem}-${n}.${ext}`;
      if (!isTaken(rel)) return rel;
    }
  }
  const stem = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
  let rel = `${base}/${stem}.${ext}`;
  for (let n = 1; isTaken(rel); n++) rel = `${base}/${stem}-${n}.${ext}`;
  return rel;
}

/** 由相对路径生成 markdown 插入文本（纯函数）。 */
export function buildImageMarkdown(rel: string, linkStyle: "wikilink" | "markdown", alt = ""): string {
  return linkStyle === "markdown" ? `![${alt}](${rel})` : `![[${rel}]]`;
}

const baseName = (p: string) => p.split("/").pop() || p;

/** 从 `fromDir` 到 vault 相对路径 `toPath` 的相对写法（纯函数）。 */
export function relativePath(fromDir: string, toPath: string): string {
  const from = fromDir.split("/").filter(Boolean);
  const to = toPath.split("/").filter(Boolean);
  let i = 0;
  while (i < from.length && i < to.length && from[i] === to[i]) i++;
  return [...Array(from.length - i).fill(".."), ...to.slice(i)].join("/");
}

/**
 * 生成写入笔记的链接路径（纯函数）。
 * - `absolute`（默认，等同历史行为）：vault 相对全路径 `attachments/2026-10/x.png`
 * - `relative`：相对当前笔记所在目录 `../attachments/2026-10/x.png`
 * - `shortest`：仅文件名 `x.png`（vault 内唯一时），否则回落 absolute
 */
export function buildImageLinkPath(
  rel: string,
  linkFormat: "absolute" | "relative" | "shortest",
  ctx: { activeFile?: string; files?: string[] } = {},
): string {
  if (linkFormat === "shortest") {
    const base = baseName(rel);
    const taken = (ctx.files ?? []).some(f => baseName(f) === base);
    return taken ? rel : base;
  }
  if (linkFormat === "relative") {
    const active = ctx.activeFile ?? "";
    const dir = active.includes("/") ? active.slice(0, active.lastIndexOf("/")) : "";
    return relativePath(dir, rel) || rel;
  }
  return rel;
}

/** 可安全转 webp 的光栅格式（不动 svg/gif/ico，避免丢矢量/动画）。 */
const WEBP_CONVERTIBLE = new Set(["png", "jpg", "jpeg", "bmp"]);

/** 用 canvas 把图片编码为 webp；不支持/失败时返回 null（调用方回落原图）。 */
async function encodeWebp(file: File, quality = 0.92): Promise<Blob | null> {
  try {
    if (typeof createImageBitmap !== "function" || typeof document === "undefined") return null;
    const bmp = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bmp, 0, 0);
    bmp.close?.();
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/webp", quality));
    return blob && blob.size > 0 ? blob : null;
  } catch {
    return null;
  }
}

async function saveImage(view: EditorView, file: File, opts: EditorExtOptions, pos?: number): Promise<void> {
  let ext = (file.name.match(/\.(\w+)$/)?.[1] || file.type.split("/")[1] || "png").toLowerCase();
  const cfg = opts.getAttachConfig?.() ?? DEFAULT_ATTACH_CONFIG;
  const isTaken = (rel: string) => usedNames.has(rel) || (opts.getFiles?.() ?? []).includes(rel);
  // 转 webp（默认关闭）—— 成功后扩展名随之改变
  let blob: Blob = file;
  if (cfg.convertWebp && WEBP_CONVERTIBLE.has(ext)) {
    const webp = await encodeWebp(file);
    if (webp) { blob = webp; ext = "webp"; }
  }
  const rel = buildAttachmentRel(cfg, ext, new Date(), isTaken);
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const data = Array.from(new Uint8Array(await blob.arrayBuffer()));
    await invoke("write_attachment", { path: rel, data });
    usedNames.add(rel);
    const linkPath = buildImageLinkPath(rel, cfg.linkFormat, {
      activeFile: opts.getActiveFile?.() ?? "",
      files: opts.getFiles?.() ?? [],
    });
    const alt = file.name.replace(/\.[^.]+$/, "");
    const insertText = buildImageMarkdown(linkPath, cfg.linkStyle, alt);
    const p = pos ?? view.state.selection.main.head;
    view.dispatch({ changes: { from: p, insert: insertText }, selection: { anchor: p + insertText.length } });
  } catch (e) {
    console.error("保存图片失败", e);
  }
}

function pasteImageHandler(view: EditorView, event: ClipboardEvent, opts: EditorExtOptions): boolean {
  const files = Array.from(event.clipboardData?.files ?? []).filter(f => f.type.startsWith("image/"));
  if (files.length === 0) return false;
  event.preventDefault();
  files.forEach(f => saveImage(view, f, opts));
  return true;
}

function dropImageHandler(view: EditorView, event: DragEvent, opts: EditorExtOptions): boolean {
  const files = Array.from(event.dataTransfer?.files ?? []).filter(f => f.type.startsWith("image/"));
  if (files.length === 0) return false;
  event.preventDefault();
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
  files.forEach(f => saveImage(view, f, opts, pos ?? undefined));
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

const lpThemeStyles = (dark: boolean) => ({
  "&": {
    fontSize: "14px",
    backgroundColor: dark ? "#1e1e1e" : "#fefefe",
    color: dark ? "#d4d4d4" : "#24292f",
  },
  ".cm-scroller": {
    fontFamily: '"SF Mono", "Fira Code", "Cascadia Code", Consolas, monospace',
    lineHeight: "1.7",
    padding: "12px 16px",
  },
  ".cm-content": { caretColor: dark ? "#e6e6e6" : "#222" },
  ".cm-gutters": {
    backgroundColor: dark ? "#252526" : "#fafafa",
    color: dark ? "#5a5a5a" : "#bbb", border: "none",
  },
  ".cm-activeLine": { backgroundColor: dark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.03)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: dark ? "#cfcfcf" : "#666" },
  // Live preview 视觉
  ".lp-heading": { fontWeight: 600 },
  ".lp-h1": { fontSize: "1.9em", lineHeight: "1.4" },
  ".lp-h2": { fontSize: "1.6em", lineHeight: "1.4" },
  ".lp-h3": { fontSize: "1.35em" },
  ".lp-h4": { fontSize: "1.2em" },
  ".lp-h5": { fontSize: "1.1em" },
  ".lp-h6": { fontSize: "1em", color: dark ? "#9a9a9a" : "#666" },
  ".lp-bold": { fontWeight: 700 },
  ".lp-italic": { fontStyle: "italic" },
  ".lp-del": { textDecoration: "line-through", color: dark ? "#808080" : "#999" },
  ".lp-inline-code": {
    background: dark ? "#2d2d30" : "#f0f1f3", borderRadius: "4px",
    padding: "1px 4px", color: dark ? "#f0a5a5" : "#cf222e", fontSize: "0.92em",
  },
  ".lp-mark": { color: dark ? "#5a5a5a" : "#b3b3b3" },
  ".lp-quote": {
    borderLeft: dark ? "3px solid #3c3c3c" : "3px solid #d0d7de",
    paddingLeft: "10px", color: dark ? "#a0a0a0" : "#57606a",
  },
  ".lp-codeline": { background: dark ? "#252526" : "#f6f8fa" },
  ".lp-codeblock": {
    background: dark ? "#252526" : "#f6f8fa", borderRadius: "6px",
    margin: "0", overflowX: "auto", display: "block",
  },
  // ── 表格（live 模式渲染成表格外观，光标行回显源码）──
  ".lp-trow": {
    fontFamily: "inherit", fontSize: "1em",
    padding: "3px 0", lineHeight: "1.6",
  },
  ".lp-trow-head": {
    fontWeight: 600,
    background: dark ? "#252526" : "#f6f8fa",
    borderTop: `1px solid ${dark ? "#3c3c3c" : "#d0d7de"}`,
    borderLeft: `1px solid ${dark ? "#3c3c3c" : "#d0d7de"}`,
    borderRight: `1px solid ${dark ? "#3c3c3c" : "#d0d7de"}`,
  },
  ".lp-trow-last": {
    borderLeft: `1px solid ${dark ? "#3c3c3c" : "#d0d7de"}`,
    borderRight: `1px solid ${dark ? "#3c3c3c" : "#d0d7de"}`,
    borderBottom: `1px solid ${dark ? "#3c3c3c" : "#d0d7de"}`,
  },
  ".lp-trow-delim": {
    borderBottom: `1px solid ${dark ? "#3c3c3c" : "#d0d7de"}`,
    borderLeft: `1px solid ${dark ? "#3c3c3c" : "#d0d7de"}`,
    borderRight: `1px solid ${dark ? "#3c3c3c" : "#d0d7de"}`,
    background: "transparent",
  },
  ".lp-tcell": { padding: "0 6px" },
  ".lp-tsep": {
    color: dark ? "#4d4d4d" : "#b6bdc4",
    fontWeight: 400,
  },
  ".lp-trow:hover .lp-tcell": { background: dark ? "#2f2f33" : "#eef2f7" },
  ".lp-trow:hover .lp-tsep": { color: dark ? "#5a5a5a" : "#a8b2ba" },
  ".lp-link": { color: dark ? "#6cb2ff" : "#0969da", textDecoration: "underline" },
  ".lp-wikilink": {
    color: dark ? "#6cb2ff" : "#0969da", background: dark ? "#1c3a5e" : "#ddf4ff",
    borderRadius: "3px", padding: "1px 4px", cursor: "pointer",
  },
  ".lp-wikilink:hover": { background: dark ? "#26507f" : "#b6e0ff", textDecoration: "underline" },
  ".lp-wikilink-missing": {
    color: dark ? "#f0883e" : "#bc4c00", background: dark ? "#3a2a12" : "#ffe8d6",
    borderBottom: "1px dashed currentColor",
  },
  ".lp-embed-image": { display: "block", margin: "6px 0" },
  ".lp-task-checkbox": { marginRight: "4px", cursor: "pointer" },
  ".cm-selectionBackground": { backgroundColor: dark ? "#264f78 !important" : "#b4d5fe !important" },
  ".cm-searchMatch": { backgroundColor: dark ? "#5a3d10" : "#fff3c4" },
  ".cm-searchMatch-selected": { backgroundColor: dark ? "#8a5a12" : "#ffd700" },
});

export const nfTheme = EditorView.theme(lpThemeStyles(false));
export const nfThemeDark = EditorView.theme(lpThemeStyles(true));

export function themeFor(name: "light" | "dark"): Extension {
  return name === "dark" ? nfThemeDark : nfTheme;
}

// ── 汇总 ────────────────────────────────────────────────────────────

export interface EditorExtOptions {
  /** live 模式：启用 Live Preview 装饰 */
  live: boolean;
  /** 是否显示行号（source/split 模式） */
  lineNumbers: boolean;
  /** wikilink 补全文件列表 */
  getFiles: () => string[];
  /** 亮/暗主题 */
  theme?: "light" | "dark";
  /** 追加 keymap（Ctrl+S 等，优先级更高） */
  extraKeys?: any[];
  /** wikilink 目标是否存在于 vault（live 模式下标记未解析链接） */
  resolveLink?: (target: string) => boolean;
  /** 图片/附件插入配置（getter，热更新无需重建 EditorView） */
  getAttachConfig?: () => AttachConfig;
  /** 当前激活文件路径（relative 链接格式需要） */
  getActiveFile?: () => string;
  /** 图片 src 解析（data URL / asset URL），供 Live Preview 与预览面板复用 */
  resolveImageSrc?: (rel: string) => Promise<string>;
}

export function nfExtensions(opts: EditorExtOptions): Extension[] {
  return [
    themeFor(opts.theme ?? "light"),
    ...(opts.live ? [livePreview({ resolveLink: opts.resolveLink, resolveImageSrc: opts.resolveImageSrc })] : []),
    tableEditing(),
    autocompletion({ override: [makeWikilinkSource(opts.getFiles)] }),
    closeBrackets(),
    EditorView.domEventHandlers({
      paste: ((view: EditorView, e: ClipboardEvent) => pasteImageHandler(view, e, opts)) as any,
      drop: ((view: EditorView, e: DragEvent) => dropImageHandler(view, e, opts)) as any,
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
