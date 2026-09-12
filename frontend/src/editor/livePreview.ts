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
import { highlightCode } from "./highlight";

// ── Widgets ─────────────────────────────────────────────────────────

/** `[[target|alias]]` → 可点击胶囊（点击由文档级 data-note 委托处理） */
class WikilinkWidget extends WidgetType {
  target: string;
  display: string;
  constructor(target: string, display: string) {
    super();
    this.target = target;
    this.display = display;
  }
  eq(other: WikilinkWidget) { return other.target === this.target && other.display === this.display; }
  toDOM() {
    const span = document.createElement("span");
    span.className = "lp-wikilink";
    span.setAttribute("data-note", this.target);
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

/** 代码块内容 → hljs 高亮 */
class CodeBlockWidget extends WidgetType {
  code: string;
  lang: string;
  constructor(code: string, lang: string) {
    super();
    this.code = code;
    this.lang = lang;
  }
  eq(other: CodeBlockWidget) { return other.code === this.code && other.lang === this.lang; }
  toDOM() {
    const pre = document.createElement("pre");
    pre.className = "lp-codeblock";
    const code = document.createElement("code");
    code.innerHTML = highlightCode(this.code, this.lang);
    pre.appendChild(code);
    return pre;
  }
  ignoreEvent() { return false; }
}

// ── Decoration builder ──────────────────────────────────────────────

const wikilinkRe = /\[\[([^\]\n]+?)(?:\|([^\]\n]+))?\]\]/g;
const embedImageRe = /!\[\[([^\]\n]+?)\]\]/g;

function buildDecorations(view: EditorView): DecorationSet {
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
            add(text.from, text.to, Decoration.replace({
              widget: new CodeBlockWidget(state.doc.sliceString(text.from, text.to), lang),
              block: false,
            }));
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
          const start = lineOf(node.from).number, end = lineOf(node.to).number;
          for (let l = start; l <= end; l++) {
            const line = state.doc.line(l);
            add(line.from, line.from, Decoration.line({ class: "lp-tableline" }));
          }
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
        add(start, start + m[0].length,
          Decoration.replace({ widget: new WikilinkWidget(m[1], m[2] || m[1]) }));
      }
    }
  }

  return RangeSet.of(decos.map(d => d.deco.range(d.from, d.to)), true);
}

/** Live preview 扩展：live 模式下启用，source/split 模式卸载 */
export function livePreview(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) { this.decorations = buildDecorations(view); }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged) {
          this.decorations = buildDecorations(u.view);
        }
      }
    },
    { decorations: (v) => v.decorations }
  );
}

