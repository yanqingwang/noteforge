/**
 * 焦点模式 / 打字机模式测试：
 * - activeBlockLines：光标所在块覆盖的行（纯函数）；
 * - focusMode：非当前块的行带 .nf-focus-dim；
 * - typewriterMode：编辑器根节点带 .nf-typewriter 类，卸载后移除。
 */
import { describe, it, expect } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { activeBlockLines, focusMode, typewriterMode } from "./focusMode";

function mkState(doc: string, anchor: number) {
  return EditorState.create({
    doc,
    selection: { anchor },
    extensions: [markdown({ extensions: [GFM] })],
  });
}

const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b);

describe("activeBlockLines", () => {
  it("光标在第一段多行段落里 → 聚焦块覆盖该段所有行", () => {
    const doc = "第一段第一行\n第一段第二行\n\n第二段\n";
    expect(sorted(activeBlockLines(mkState(doc, 1)))).toEqual([1, 2]);
  });

  it("光标在第二段 → 只覆盖第二段的行", () => {
    const doc = "第一段第一行\n第一段第二行\n\n第二段\n";
    // 第二段从位置 15 开始（第 4 行）
    expect(sorted(activeBlockLines(mkState(doc, 16)))).toEqual([4]);
  });

  it("光标落在空行 → 退化为该单行", () => {
    const doc = "第一段\n\n第二段\n";   // 空行 = 第 2 行（from=4）
    expect(sorted(activeBlockLines(mkState(doc, 4)))).toEqual([2]);
  });

  it("光标在标题行 → 覆盖标题行", () => {
    const doc = "# 标题\n\n正文\n";
    expect(sorted(activeBlockLines(mkState(doc, 3)))).toEqual([1]);
  });
});

describe("focusMode 装饰", () => {
  it("非当前块的行被淡化，当前块不被淡化", () => {
    const doc = "第一段\n\n第二段\n";
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc,
        selection: { anchor: 1 },
        extensions: [markdown({ extensions: [GFM] }), focusMode()],
      }),
    });
    const dimmed = Array.from(view.dom.querySelectorAll(".nf-focus-dim")).map(e => e.textContent);
    expect(dimmed.length).toBeGreaterThan(0);
    expect(dimmed.join("|")).not.toContain("第一段");
    view.destroy();
  });
});

const nextFrame = () => new Promise(r => requestAnimationFrame(() => r(null)));

describe("typewriterMode", () => {
  it("光标移动时请求把光标行滚到视口中央（y: center）", async () => {
    const orig = EditorView.scrollIntoView;
    const calls: Array<{ opts?: { y?: string } }> = [];
    (EditorView as any).scrollIntoView = (pos: number, opts?: any) => {
      calls.push({ opts });
      return orig(pos, opts);
    };
    try {
      const view = new EditorView({
        parent: document.body,
        state: EditorState.create({
          doc: "一行文本\n第二行\n",
          selection: { anchor: 2 },
          extensions: [markdown({ extensions: [GFM] }), typewriterMode()],
        }),
      });
      view.dispatch({ selection: { anchor: 3 } });
      await nextFrame();
      await nextFrame();
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.some(c => c.opts?.y === "center")).toBe(true);
      view.destroy();
    } finally {
      (EditorView as any).scrollIntoView = orig;
    }
  });
});
