/**
 * EditorPane 挂载级测试（jsdom）：验证“即输即显”live 模式的接线 ——
 * mode="live" 挂载后 CM6 渲染富文本装饰（隐藏语法），而非显示源码。
 * 这是 App 层问题「即输即显显示源代码」的组件级证据。
 */
import { describe, it, expect } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import EditorPane from "./EditorPane";

const DOC = "开头一行\n# 标题行\n- [ ] 待办任务\n**加粗文本**";

describe("EditorPane live 模式（即输即显）", () => {
  it("mode=live 挂载：非光标行渲染为富文本，不显示源码", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    const outlines: number[] = [];
    act(() => {
      root.render(
        <EditorPane content={DOC} previewHtml="" activeFile="笔记.md"
          mode="live" onOutline={(items) => outlines.push(items.length)} />,
      );
    });

    const editor = container.querySelector(".cm-editor");
    expect(editor).toBeTruthy();

    // 标题行（非光标行）：有 lp-h1 装饰、原始 "# " 被隐藏
    expect(editor!.querySelector(".lp-heading.lp-h1")).toBeTruthy();
    expect(editor!.textContent).toContain("标题行");
    expect(editor!.textContent).not.toContain("# 标题行");

    // 任务行渲染为复选框控件
    expect(editor!.querySelector(".lp-task-checkbox")).toBeTruthy();

    // 加粗：原始 ** 被隐藏（光标在首行，第 4 行非光标）
    expect(editor!.textContent).toContain("加粗文本");
    expect(editor!.textContent).not.toContain("**加粗文本**");

    // 大纲回调收到标题（内容已解析）
    expect(outlines[0]).toBe(1);

    act(() => root.unmount());
    container.remove();
  });

  it("mode=source 挂载：原样显示源码（对照组）", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    act(() => {
      root.render(
        <EditorPane content={DOC} previewHtml="" activeFile="笔记.md" mode="source" />,
      );
    });
    const editor = container.querySelector(".cm-editor");
    expect(editor).toBeTruthy();
    expect(editor!.textContent).toContain("# 标题行");
    expect(editor!.querySelector(".lp-heading")).toBeNull();

    act(() => root.unmount());
    container.remove();
  });
});
