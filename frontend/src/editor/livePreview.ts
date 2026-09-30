/**
 * Live Preview 装饰插件（Typora/MarkText 风格，ED-02）。
 *
 * 规则：非光标所在行隐藏语法标记并渲染样式；光标行回显源码。
 * 语义渲染仍以 comrak 为准绳（preview/split pane），本插件只负责视觉。
 */
import { ViewPlugin, Decoration, WidgetType } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { DecorationSet, EditorView, ViewUpdate } from "@codemirror/view";
import { RangeSet } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import type { SyntaxNodeRef } from "@lezer/common";
import { highlightCode } from "./highlight";
import { splitWikilink } from "./wikilink";

// ── Widgets ─────────────────────────────────────────────────────────

/** `[[target|alias]]` → 可点击胶囊（点击由文档级 data-note 委托处理） */
class WikilinkWidget extends WidgetType {
  target: string;
  display: string;
  resolved: boolean;
  constructor(target: string, display: string, resolved = true) {
    super();
    this.target = target;
    this.display = display;
    this.resolved = resolved;
  }
  eq(other: WikilinkWidget) {
    return other.target === this.target && other.display === this.display
      && other.resolved === this.resolved;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = this.resolved ? "lp-wikilink" : "lp-wikilink lp-wikilink-missing";
    // data-note 只放文件目标：#标题/^块 与别名不参与文件匹配
    span.setAttribute("data-note", this.target);
    if (!this.resolved) span.title = "未找到该文件";
    span.textContent = this.display;
    return span;
  }
  ignoreEvent() { return false; }
}

/** `![[img.png]]` → 内联图片预览 */
class EmbedImageWidget extends WidgetType {
  private static cache = new Map<string, string>();
  target: string;
  constructor(target: string) {
    super();
    this.target = target;
  }
  eq(other: EmbedImageWidget) { return other.target === this.target; }
  toDOM(_view: EditorView) {
    const wrap = document.createElement("span");
    wrap.className = "lp-embed-image";
    const img = document.createElement("img");
    img.style.maxWidth = "100%";
    img.style.maxHeight = "220px";
    img.style.borderRadius = "6px";
    img.alt = this.target;
    const cached = EmbedImageWidget.cache.get(this.target);
    if (cached) {
      img.src = cached;
    } else {
      import("@tauri-apps/api/core").then(({ invoke }) =>
        invoke<string>("read_file_data", { path: this.target }).then((url) => {
          EmbedImageWidget.cache.set(this.target, url);
          img.src = url;
        }).catch(() => { wrap.textContent = `⚠ 未找到附件: ${this.target}`; })
      );
    }
    wrap.appendChild(img);
    return wrap;
  }
  ignoreEvent() { return false; }
}

/** `- [ ]` / `- [x]` → 可点击复选框（点击回写文档） */
class TaskCheckboxWidget extends WidgetType {
  checked: boolean;
  from: number;
  to: number;
  constructor(checked: boolean, from: number, to: number) {
    super();
    this.checked = checked;
    this.from = from;
    this.to = to;
  }
  eq(other: TaskCheckboxWidget) { return other.checked === this.checked && other.from === this.from && other.to === this.to; }
  toDOM(view: EditorView) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = this.checked;
    box.className = "lp-task-checkbox";
    box.addEventListener("mousedown", (e) => e.preventDefault());
    box.addEventListener("click", (e) => {
      e.preventDefault();
      view.dispatch({ changes: { from: this.from, to: this.to, insert: this.checked ? "[ ]" : "[x]" } });
    });
    return box;
  }
  ignoreEvent() { return false; }
}

/**
 * 代码块内容 → hljs 高亮。
 * 跨行代码块在 decoration block 中渲染（见 FencedCode 分支）：
 * `part="open"` 输出 <pre>，中间行由 CSS 撑开，`part="close"` 只闭合 </pre>。
 */
class CodeBlockWidget extends WidgetType {
  code: string;
  lang: string;
  part: "whole" | "open" | "close";
  constructor(code: string, lang: string, part: "whole" | "open" | "close" = "whole") {
    super();
    this.code = code;
    this.lang = lang;
    this.part = part;
  }
  eq(other: CodeBlockWidget) {
    return other.code === this.code && other.lang === this.lang && other.part === this.part;
  }
  toDOM() {
    const pre = document.createElement("pre");
    pre.className = "lp-codeblock";
    if (this.part !== "close") {   // "close" 只闭合 </pre>，不重复内容
      const code = document.createElement("code");
      code.innerHTML = highlightCode(this.code, this.lang);
      pre.appendChild(code);
    }
    return pre;
  }
  ignoreEvent() { return false; }
}

// ── Decoration builder ──────────────────────────────────────────────

const wikilinkRe = /\[\[([^\]\n]+?)(?:\|([^\]\n]+))?\]\]/g;
const embedImageRe = /!\[\[([^\]\n]+?)\]\]/g;

/**
 * 表格渲染（对标 Obsidian 编辑视图）：
 *  - 非光标行：渲染成表格外观（表头加粗浅底、竖线淡化成网格线、行间横线），
 *    单元格文字即文档原文，所以可以直接在单元格里改数据；
 *  - 光标所在行：回显源码管道符，方便改结构；
 *  - 对齐行（| --- | --- |）：默认渲染成一条横线，光标落上去才显示三条短线。
 *
 * 全程不改文档结构，只用 line/mark/replace(同行内) 装饰，避免块级装饰
 * 触发 CM6 的 "Block decorations may not be specified via plugins"。
 */
function decorateTable(
  view: EditorView,
  node: SyntaxNodeRef,
  focusLines: Set<number>,
  add: (from: number, to: number, deco: Decoration) => void,
) {
  const state = view.state;
  const firstLine = state.doc.lineAt(node.from).number;
  const lastLine = state.doc.lineAt(node.to).number;

  for (let l = firstLine; l <= lastLine; l++) {
    if (focusLines.has(l)) continue;              // 光标行回显源码
    const line = state.doc.line(l);
    const cells = tableCells(line.text);
    if (!cells) continue;
    const isDelim = isDelimRow(line.text);

    // 行装饰：表头 / 中间行 / 末行，拼出表格边框
    const cls = isDelim
      ? "lp-trow lp-trow-delim"
      : `lp-trow${l === firstLine ? " lp-trow-head" : ""}${l === lastLine ? " lp-trow-last" : ""}`;
    add(line.from, line.from, Decoration.line({ class: cls }));

    // 对齐行：把 --- 藏掉，交给 CSS 的 border 画横线
    if (isDelim) {
      for (const seg of cells) {
        if (line.text.slice(seg.start, seg.end).includes("-")) {
          add(line.from + seg.start, line.from + seg.end, Decoration.replace({}));
        }
      }
      // 淡化的竖线（保留在文本里，不做替换，列宽不会塌）
      for (const p of pipesOf(line.text)) {
        add(line.from + p, line.from + p + 1, Decoration.mark({ class: "lp-tsep" }));
      }
      continue;
    }

    // 数据/表头行：单元格内容加内边距，竖线淡化成网格线
    for (const seg of cells) {
      add(line.from + seg.start, line.from + seg.end, Decoration.mark({ class: "lp-tcell" }));
    }
    for (const p of pipesOf(line.text)) {
      add(line.from + p, line.from + p + 1, Decoration.mark({ class: "lp-tsep" }));
    }
  }
}

/** 一行是否是表格行（去掉缩进后以 | 开头或结尾、且含 |） */
function isTableRowText(text: string): boolean {
  const t = text.trim();
  return t.includes("|") && (t.startsWith("|") || t.endsWith("|"));
}

/** 单元格内容的 [start,end) 区间（相对行首，不含两侧空白与竖线） */
function tableCells(text: string): Array<{ start: number; end: number }> | null {
  if (!isTableRowText(text)) return null;
  const out: Array<{ start: number; end: number }> = [];
  let segStart = 0;
  const pipes = pipesOf(text);
  for (const p of pipes) {
    if (p === 0) { segStart = 1; continue; }         // 行首竖线
    let s = segStart, e = p;
    while (s < e && (text[s] === " " || text[s] === "\t")) s++;
    while (e > s && (text[e - 1] === " " || text[e - 1] === "\t")) e--;
    if (e > s) out.push({ start: s, end: e });
    segStart = p + 1;
  }
  if (text.slice(segStart).trim() !== "") {
    let s = segStart, e = text.length;
    while (e > s && (text[e - 1] === " ")) e--;
    out.push({ start: s, end: e });
  }
  return out;
}

/** 未转义竖线位置 */
function pipesOf(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "|" && (i === 0 || text[i - 1] !== "\\")) out.push(i);
  }
  return out;
}

/** 是否是对齐行（| --- | :---: | ---: |） */
function isDelimRow(text: string): boolean {
  const t = text.trim();
  return t.includes("-") && /^[\s|:-]*-[\s|:-]*$/.test(t);
}

function buildDecorations(view: EditorView, resolve?: (t: string) => boolean): DecorationSet {
  const decos: Array<{ from: number; to: number; deco: Decoration }> = [];
  const add = (from: number, to: number, deco: Decoration) => decos.push({ from, to, deco });
  const state = view.state;

  // 光标所在行集合：这些行回显源码
  const focusLines = new Set<number>();
  for (const range of state.selection.ranges) {
    const fromLine = state.doc.lineAt(range.from).number;
    const toLine = state.doc.lineAt(range.to).number;
    for (let l = fromLine; l <= toLine; l++) focusLines.add(l);
  }

  const lineOf = (pos: number) => state.doc.lineAt(pos);
  const lineFocused = (from: number, to: number) => {
    const a = lineOf(from).number, b = lineOf(Math.max(from, to - 1)).number;
    for (let l = a; l <= b; l++) if (focusLines.has(l)) return true;
    return false;
  };

  for (const { from, to } of view.visibleRanges) {
    // ── 语法树驱动的块级/行内装饰 ──
    syntaxTree(state).iterate({
      from, to,
      enter: (node) => {
        const { name } = node;
        // 标题：行样式 + 隐藏 # 标记
        const heading = name.match(/^ATXHeading(\d)$/);
        if (heading) {
          const level = heading[1];
          add(node.from, node.from, Decoration.line({ class: `lp-heading lp-h${level}` }));
          if (!lineFocused(node.from, node.to)) {
            // 隐藏行首 "### " 标记
            const line = lineOf(node.from);
            const markLen = line.text.match(/^#{1,6}\s/)?.[0].length ?? 0;
            if (markLen > 0) {
              add(node.from, node.from + markLen, Decoration.replace({}));
            }
          }
          return;
        }
        if (name === "StrongEmphasis") {
          if (!lineFocused(node.from, node.to)) {
            add(node.from, node.from + 2, Decoration.replace({}));
            add(node.to - 2, node.to, Decoration.replace({}));
            add(node.from + 2, node.to - 2, Decoration.mark({ class: "lp-bold" }));
          } else {
            add(node.from, node.to, Decoration.mark({ class: "lp-mark" }));
          }
          return;
        }
        if (name === "Emphasis") {
          if (!lineFocused(node.from, node.to)) {
            add(node.from, node.from + 1, Decoration.replace({}));
            add(node.to - 1, node.to, Decoration.replace({}));
            add(node.from + 1, node.to - 1, Decoration.mark({ class: "lp-italic" }));
          } else {
            add(node.from, node.to, Decoration.mark({ class: "lp-mark" }));
          }
          return;
        }
        if (name === "Strikethrough") {
          if (!lineFocused(node.from, node.to)) {
            add(node.from, node.from + 2, Decoration.replace({}));
            add(node.to - 2, node.to, Decoration.replace({}));
            add(node.from + 2, node.to - 2, Decoration.mark({ class: "lp-del" }));
          }
          return;
        }
        if (name === "InlineCode") {
          if (!lineFocused(node.from, node.to)) {
            add(node.from, node.from + 1, Decoration.replace({}));
            add(node.to - 1, node.to, Decoration.replace({}));
            add(node.from + 1, node.to - 1, Decoration.mark({ class: "lp-inline-code" }));
          } else {
            add(node.from, node.to, Decoration.mark({ class: "lp-mark" }));
          }
          return;
        }
        if (name === "Blockquote") {
          // 每行加引用样式；未聚焦行隐藏 "> " 标记
          let pos = node.from;
          while (pos <= node.to) {
            const line = lineOf(pos);
            add(line.from, line.from, Decoration.line({ class: "lp-quote" }));
            if (!focusLines.has(line.number)) {
              const m = line.text.match(/^>\s?/);
              if (m) add(line.from, line.from + m[0].length, Decoration.replace({}));
            }
            if (line.to >= node.to) break;
            pos = line.to + 1;
          }
          return;
        }
        if (name === "FencedCode") {
          const info = node.node.getChild("CodeInfo");
          const lang = info ? state.doc.sliceString(info.from, info.to) : "";
          const text = node.node.getChild("CodeText");
          const lineStart = lineOf(node.from);
          const lineEnd = lineOf(node.to);
          for (let l = lineStart.number; l <= lineEnd.number; l++) {
            const line = state.doc.line(l);
            add(line.from, line.from, Decoration.line({ class: "lp-codeline" }));
          }
          if (text && !lineFocused(node.from, node.to)) {
            // CM6 硬约束（measure 阶段抛 RangeError → 整窗白屏）：
            //  - 行内 replace 装饰不能跨换行
            //  - 块级（block:true）replace 装饰不允许由 ViewPlugin 提供
            // 所以跨行代码块不能用 replace 装饰：改用 decoration block 里的
            // 零宽 widget 装饰（同行起止两处），块本身由行装饰的 CSS 撑开。
            const code = state.doc.sliceString(text.from, text.to);
            const first = state.doc.lineAt(text.from);
            const last = state.doc.lineAt(text.to);
            if (first.number === last.number) {
              add(text.from, text.to, Decoration.replace({
                widget: new CodeBlockWidget(code, lang),
                block: false,
              }));
            } else {
              add(first.from, first.from, Decoration.widget({
                widget: new CodeBlockWidget(code, lang, "open"), side: -1,
              }));
              for (let l = first.number; l <= last.number; l++) {
                const line = state.doc.line(l);
                add(line.from, line.to, Decoration.replace({}));
              }
              add(last.to, last.to, Decoration.widget({
                widget: new CodeBlockWidget(code, lang, "close"), side: 1,
              }));
            }
          }
          return;
        }
        if (name === "TaskMarker") {
          const checked = state.doc.sliceString(node.from, node.to).includes("[x]") ||
            state.doc.sliceString(node.from, node.to).toLowerCase().includes("[x]");
          if (!focusLines.has(lineOf(node.from).number)) {
            add(node.from, node.to, Decoration.replace({
              widget: new TaskCheckboxWidget(checked, node.from, node.to),
            }));
          }
          return;
        }
        if (name === "Link" || name === "URL") {
          add(node.from, node.to, Decoration.mark({ class: "lp-link" }));
          return;
        }
        if (name === "Table") {
          decorateTable(view, node, focusLines, add);
          return;
        }
      },
    });

    // ── 正则驱动的 wikilink / 嵌入图片（lezer 不认识） ──
    for (let l = lineOf(from).number; l <= lineOf(to).number; l++) {
      const line = state.doc.line(l);
      if (focusLines.has(l)) continue;
      for (const m of line.text.matchAll(embedImageRe)) {
        const target = m[1].split("|")[0];
        if (/\.(png|jpe?g|gif|svg|webp|bmp|ico)$/i.test(target)) {
          add(line.from + (m.index ?? 0), line.from + (m.index ?? 0) + m[0].length,
            Decoration.replace({ widget: new EmbedImageWidget(target) }));
        }
      }
      for (const m of line.text.matchAll(wikilinkRe)) {
        // 嵌入图片已处理，跳过 ![[ ]]（正则不带 !，不会重叠）
        const start = line.from + (m.index ?? 0);
        const raw = m[1];
        const parts = splitWikilink(raw);
        const label = m[2] || parts.alias || parts.target;
        const resolved = !resolve || resolve(parts.target);
        add(start, start + m[0].length,
          Decoration.replace({ widget: new WikilinkWidget(parts.target, label, resolved) }));
      }
    }
  }

  return RangeSet.of(decos.map(d => d.deco.range(d.from, d.to)), true);
}

/** Live preview 扩展：live 模式下启用，source/split 模式卸载 */
export function livePreview(resolveTarget?: (t: string) => boolean): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) { this.decorations = buildDecorations(view, resolveTarget); }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged) {
          this.decorations = buildDecorations(u.view, resolveTarget);
        }
      }
    },
    { decorations: (v) => v.decorations }
  );
}

