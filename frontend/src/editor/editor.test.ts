/**
 * CM6 编辑器行为测试（jsdom headless）：
 * 列表续行、格式快捷键、live 模式装饰创建不破坏文档。
 */
import { describe, it, expect } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { nfExtensions, listContinue } from "./extensions";

function makeView(doc: string, opts: { live?: boolean } = {}) {
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc,
      extensions: [
        markdown({ extensions: [GFM] }),
        ...nfExtensions({ live: opts.live ?? false, lineNumbers: false, getFiles: () => [] }),
      ],
    }),
  });
  return view;
}

const typeKey = (view: EditorView, key: string, opts: Partial<KeyboardEventInit> = {}) => {
  const dom = view.contentDOM;
  dom.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...opts }));
};

describe("listContinue（列表续行）", () => {
  it("continues an unordered list on Enter", () => {
    const view = makeView("- 第一项");
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    expect(listContinue(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("- 第一项\n- ");
    expect(view.state.selection.main.head).toBe(view.state.doc.length);
    view.destroy();
  });

  it("increments ordered list numbers", () => {
    const view = makeView("1. 甲\n2. 乙");
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    listContinue(view);
    expect(view.state.doc.toString()).toBe("1. 甲\n2. 乙\n3. ");
    view.destroy();
  });

  it("continues task list as unchecked", () => {
    const view = makeView("- [x] done thing");
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    listContinue(view);
    expect(view.state.doc.toString()).toBe("- [x] done thing\n- [ ] ");
    view.destroy();
  });

  it("cancels list on empty item", () => {
    const view = makeView("- 已有项\n- ");
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    listContinue(view);
    expect(view.state.doc.toString()).toBe("- 已有项\n");
    view.destroy();
  });

  it("leaves plain text alone", () => {
    const view = makeView("普通段落");
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    expect(listContinue(view)).toBe(false);
    expect(view.state.doc.toString()).toBe("普通段落");
    view.destroy();
  });
});

describe("format hotkeys（格式快捷键）", () => {
  it("wraps selection with bold via Mod-b", () => {
    const view = makeView("hello world");
    view.dispatch({ selection: { anchor: 0, head: 5 } });
    typeKey(view, "b", { ctrlKey: true });
    expect(view.state.doc.toString()).toBe("**hello** world");
    view.destroy();
  });

  it("unwraps bold when already wrapped", () => {
    const view = makeView("**hello** world");
    view.dispatch({ selection: { anchor: 2, head: 7 } });
    typeKey(view, "b", { ctrlKey: true });
    expect(view.state.doc.toString()).toBe("hello world");
    view.destroy();
  });

  it("inserts empty bold marks and places cursor inside via Mod-b", () => {
    const view = makeView("x");
    view.dispatch({ selection: { anchor: 1 } });
    typeKey(view, "b", { ctrlKey: true });
    expect(view.state.doc.toString()).toBe("x**文本**");
    expect(view.state.selection.main.head).toBe(3); // between the marks
    view.destroy();
  });

  it("unwraps bold when selection sits inside the marks", () => {
    const view = makeView("**hello** world");
    view.dispatch({ selection: { anchor: 2, head: 7 } });
    typeKey(view, "b", { ctrlKey: true });
    expect(view.state.doc.toString()).toBe("hello world");
    view.destroy();
  });

  it("applies heading via Mod-2", () => {
    const view = makeView("标题行");
    view.dispatch({ selection: { anchor: 0 } });
    typeKey(view, "2", { ctrlKey: true });
    expect(view.state.doc.toString()).toBe("## 标题行");
    view.destroy();
  });
});

describe("live preview 装饰", () => {
  it("creates decorations without altering the document", () => {
    const doc = "# 标题\n\n正文 **加粗** 和 `代码`\n\n- [ ] 任务\n- [x] 完成\n";
    const view = makeView(doc, { live: true });
    expect(view.state.doc.toString()).toBe(doc);
    // 装饰已生效：标题行有 lp-h1 class
    const headingLine = view.domAtPos(1);
    const lineEl = (headingLine.node as HTMLElement);
    const found = lineEl.nodeType === 1
      ? (lineEl as HTMLElement).classList.contains("lp-h1")
      : true;
    expect(found).toBe(true);
    // 复选框 widget 已渲染
    expect(document.querySelectorAll(".lp-task-checkbox").length).toBe(2);
    view.destroy();
  });

  it("focused line keeps raw marks (no hide) but keeps heading size", () => {
    const doc = "# 标题";
    const view = makeView(doc, { live: true });
    // 光标在标题行内：## 不应被隐藏（DOM 里能看到 # 文本）
    expect(view.state.doc.toString()).toBe(doc);
    const text = (view.contentDOM.querySelector(".cm-line") as HTMLElement).textContent || "";
    expect(text).toContain("#");
    view.destroy();
  });

  it("typing in live mode preserves cursor and document (IME-style edits)", () => {
    const doc = "# 标题\n正文";
    const view = makeView(doc, { live: true });
    // 在最后一行输入（模拟打字事务）
    const end = view.state.doc.length;
    view.dispatch({ changes: { from: end, insert: "内容" }, selection: { anchor: end + 2 } });
    expect(view.state.doc.toString()).toBe("# 标题\n正文内容");
    expect(view.state.selection.main.head).toBe(end + 2);
    view.destroy();
  });
});
