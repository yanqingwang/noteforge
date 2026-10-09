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

  it("外链图片不处理", () => {
    const view = makeView("![x](https://example.com/a.png)\n\n");
    expect(countImages(view)).toBe(0);
    view.destroy();
  });
});
