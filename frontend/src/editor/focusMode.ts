/**
 * 焦点模式 / 打字机模式（对标 Typora「Focus Mode」与「Typewriter Mode」）。
 *
 * - 焦点模式：光标所在块（段落/标题/列表项/代码块）正常显示，其余行淡出；
 * - 打字机模式：光标行始终垂直居中，配合 `.cm-scroller` 上下留白，
 *   首行/末行也能真正居中。
 *
 * 两者都是纯视图行为，不改文档内容，因此可以用 ViewPlugin 实现；
 * 只有行装饰（Decoration.line），不涉及跨行 replace，无 CM6 块级装饰限制。
 */
import { ViewPlugin, Decoration, EditorView } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { RangeSet } from "@codemirror/state";
import type { EditorState, Extension } from "@codemirror/state";

/**
 * 当前「聚焦块」占用的行号集合 = 光标所在的那一段连续非空行（空行即块边界），
 * 也就是 Typora/Obsidian 意义上的「当前段落」。
 *
 * 刻意不依赖语法树：CM6 的 markdown 树是分片异步解析的，打开大文件时首次构建
 * 装饰拿到的可能是「只解析了前几行」的残树，会把前若干行全部当成一个块
 * （实测：一篇 297 行报告刚打开时前 5 行被当成一块，其余全淡出）。
 * 按行判定与解析进度无关，结果稳定且可单测。
 */
export function activeBlockLines(state: EditorState): Set<number> {
  const lines = new Set<number>();
  const total = state.doc.lines;
  for (const range of state.selection.ranges) {
    const cur = state.doc.lineAt(range.head).number;
    // 光标本身在空行上：它不属于任何段落，只聚焦这一行
    if (state.doc.line(cur).text.trim() === "") { lines.add(cur); continue; }
    let a = cur, b = cur;
    while (a > 1 && state.doc.line(a - 1).text.trim() !== "") a--;
    while (b < total && state.doc.line(b + 1).text.trim() !== "") b++;
    for (let l = a; l <= b; l++) lines.add(l);
  }
  return lines;
}

function buildFocusDecorations(view: EditorView): DecorationSet {
  const state = view.state;
  const active = activeBlockLines(state);
  const decos: Array<{ from: number; deco: Decoration }> = [];
  const seen = new Set<number>();
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = state.doc.lineAt(pos);
      if (!active.has(line.number) && !seen.has(line.number)) {
        seen.add(line.number);
        decos.push({ from: line.from, deco: Decoration.line({ class: "nf-focus-dim" }) });
      }
      if (line.to >= to) break;
      pos = line.to + 1;
    }
  }
  return RangeSet.of(decos.map(d => d.deco.range(d.from)), true);
}

/** 焦点模式：仅当前块正常显示，其余行淡出。 */
export function focusMode(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) { this.decorations = buildFocusDecorations(view); }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged) {
          this.decorations = buildFocusDecorations(u.view);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}

/** 把光标滚到视口垂直居中（rAF 延后：update 阶段禁止 dispatch）。 */
function dispatchCenter(view: EditorView): void {
  const run = () => {
    if (!view.dom.isConnected) return;
    view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: "center" }) });
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
  else setTimeout(run, 16);
}

/**
 * 打字机模式：光标行始终垂直居中。
 *
 * 上下留白交给 `typewriterPadding` 主题扩展（声明式，随扩展集挂载/卸载），
 * 这里只负责把光标滚到视口中央，避免用 `view.dom.classList` 加类 ——
 * CM6 的 updateAttrs() 会整体重写编辑器根节点的 class，插件加的类会被抹掉。
 */
export function typewriterMode(): Extension {
  return ViewPlugin.fromClass(
    class {
      constructor(view: EditorView) {
        dispatchCenter(view);
      }
      update(u: ViewUpdate) {
        if (u.selectionSet || u.docChanged) dispatchCenter(u.view);
      }
    },
  );
}

/**
 * 打字机模式的上下留白：让首行/末行也能真正滚到视口中央。
 *
 * 基础主题里的 `.cm-scroller { padding: 12px 16px }` 是会覆盖本规则的简写属性，
 * 且其 StyleModule 注册次序在本模块之后（简写属性晚于本规则 → 本规则被吃掉），
 * 故这里必须用 `!important` 才能保证纵向留白生效（实测：不加则首行仍贴顶）。
 */
export const typewriterPadding = EditorView.theme({
  ".cm-scroller": {
    paddingTop: "45vh !important",
    paddingBottom: "45vh !important",
  },
});
