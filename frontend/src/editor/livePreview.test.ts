/**
 * Live Preview 图片渲染测试：
 * `![[img]]` 与 `![alt](img)` 均内联为 .lp-embed-image；非图片 / 外链 / 锚点不处理。
 */
import { describe, it, expect } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { nfExtensions } from "./extensions";
import { shouldReveal } from "./livePreview";

/** 光标落在指定位置（用于「触及才展开」的粒度测试）。 */
function makeViewAt(doc: string, anchor: number) {
  return new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc,
      selection: { anchor },
      extensions: [
        markdown({ extensions: [GFM] }),
        ...nfExtensions({ live: true, lineNumbers: false, getFiles: () => [] }),
      ],
    }),
  });
}

function makeView(doc: string) {
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc,
      // 光标放末尾空行：首行成为“非光标行”，才会被 live 装饰
      selection: { anchor: doc.length },
      extensions: [
        markdown({ extensions: [GFM] }),
        ...nfExtensions({
          live: true, lineNumbers: false, getFiles: () => [],
          resolveImageSrc: async () => "data:image/png;base64,AAAA",
        }),
      ],
    }),
  });
  return view;
}

const countImages = (view: EditorView) => view.dom.querySelectorAll(".lp-embed-image").length;

describe("livePreview 图片渲染", () => {
  it("![[attachments/a.png]] 内联渲染", () => {
    const view = makeView("![[attachments/a.png]]\n\n");
    expect(countImages(view)).toBe(1);
    view.destroy();
  });

  it("![alt](attachments/b.png) 内联渲染", () => {
    const view = makeView("![x](attachments/b.png)\n\n");
    expect(countImages(view)).toBe(1);
    view.destroy();
  });

  it("非图片扩展名不渲染", () => {
    const view = makeView("![x](attachments/note.md)\n\n");
    expect(countImages(view)).toBe(0);
    view.destroy();
  });

  it("外链 http(s) 图片直接内联渲染", () => {
    const view = makeView("![x](https://example.com/a.png)\n\n");
    expect(countImages(view)).toBe(1);
    view.destroy();
  });

  it("非 http 协议外链不处理", () => {
    const view = makeView("![x](ftp://example.com/a.png)\n\n");
    expect(countImages(view)).toBe(0);
    view.destroy();
  });
});

describe("livePreview 列表/分隔线/链接", () => {
  it("无序列表标记渲染为 •", () => {
    const view = makeView("- item a\n- item b\n\n");
    expect(view.dom.querySelectorAll(".lp-bullet").length).toBe(2);
    view.destroy();
  });

  it("有序列表保留数字，不出现 •", () => {
    const view = makeView("1. first\n2. second\n\n");
    expect(view.dom.querySelectorAll(".lp-bullet").length).toBe(0);
    view.destroy();
  });

  it("光标行回显源码（不渲染 •）", () => {
    // 光标落在首行（selection 默认 anchor=0 时 makeView 无法做到，这里直接构造）
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: "- item a\n\n",
        selection: { anchor: 1 },
        extensions: [markdown({ extensions: [GFM] }),
          ...nfExtensions({ live: true, lineNumbers: false, getFiles: () => [] })],
      }),
    });
    expect(view.dom.querySelectorAll(".lp-bullet").length).toBe(0);
    view.destroy();
  });

  it("--- 渲染为横线", () => {
    const view = makeView("above\n\n---\n\n");
    expect(view.dom.querySelectorAll(".lp-hr").length).toBe(1);
    view.destroy();
  });

  it("行内链接隐藏标记与 URL，保留文字", () => {
    const view = makeView("see [示例](https://example.com) now\n\n");
    const link = view.dom.querySelector(".lp-link");
    expect(link?.textContent).toBe("示例");
    view.destroy();
  });
});

describe("shouldReveal（行内标记展开粒度）", () => {
  it("光标落在节点区间内 → 展开", () => {
    expect(shouldReveal(0, 5, [{ from: 2, to: 2 }])).toBe(true);
  });
  it("光标落在标记区间端点（两端）→ 展开", () => {
    expect(shouldReveal(0, 5, [{ from: 0, to: 0 }])).toBe(true);
    expect(shouldReveal(0, 5, [{ from: 5, to: 5 }])).toBe(true);
  });
  it("光标在节点区间外 → 不展开", () => {
    expect(shouldReveal(0, 5, [{ from: 6, to: 6 }])).toBe(false);
    expect(shouldReveal(8, 13, [{ from: 2, to: 2 }])).toBe(false);
  });
  it("选区与节点有交集 → 展开；无交集 → 不展开", () => {
    expect(shouldReveal(0, 5, [{ from: 3, to: 9 }])).toBe(true);
    expect(shouldReveal(0, 5, [{ from: 5, to: 9 }])).toBe(true);
    expect(shouldReveal(0, 5, [{ from: 6, to: 9 }])).toBe(false);
  });
  it("多光标：任一个触及即展开", () => {
    expect(shouldReveal(0, 5, [{ from: 20, to: 20 }, { from: 4, to: 4 }])).toBe(true);
  });
});

describe("live 行内标记：只展开被触及的那一个", () => {
  it("光标在第一个加粗内 → 只有第二个加粗保持渲染", () => {
    const doc = "**a** 和 **b**\n";
    const view = makeViewAt(doc, 2);   // 光标在 "a" 上
    expect(view.dom.querySelectorAll(".lp-bold").length).toBe(1);
    expect(view.dom.querySelector(".lp-bold")?.textContent).toBe("b");
    view.destroy();
  });

  it("光标在行尾 → 同一行的两个加粗都渲染", () => {
    const view = makeViewAt("**a** 和 **b**\n", 14);
    const bolds = Array.from(view.dom.querySelectorAll(".lp-bold")).map(e => e.textContent);
    expect(bolds).toEqual(["a", "b"]);
    view.destroy();
  });

  it("光标恰好落在标记端点 → 该节点源码回显", () => {
    const view = makeViewAt("**a** 和 **b**\n", 5);   // 第一个 `**a**` 的结束位置
    expect(view.dom.querySelectorAll(".lp-bold").length).toBe(1);
    expect(view.dom.querySelector(".lp-bold")?.textContent).toBe("b");
    view.destroy();
  });

  it("行内代码：光标触及第一个 → 只渲染第二个", () => {
    const view = makeViewAt("`a` 与 `b`\n", 1);
    expect(view.dom.querySelectorAll(".lp-inline-code").length).toBe(1);
    view.destroy();
  });

  it("wikilink：光标触及第一个 → 只渲染第二个", () => {
    const view = makeViewAt("[[a]] 与 [[b]]\n", 2);
    expect(view.dom.querySelectorAll(".lp-wikilink").length).toBe(1);
    view.destroy();
  });

  it("wikilink：光标不在任一个上 → 两个都渲染", () => {
    const view = makeViewAt("[[a]] 与 [[b]]\n", 14);
    expect(view.dom.querySelectorAll(".lp-wikilink").length).toBe(2);
    view.destroy();
  });
});
