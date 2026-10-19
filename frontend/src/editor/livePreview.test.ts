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
