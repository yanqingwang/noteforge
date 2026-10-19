/**
 * TagPanel 组件测试：标签排序展示、搜索过滤、展开文件列表并点击跳转。
 */
import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactElement } from "react";
import TagPanel, { type TagInfo } from "./TagPanel";

const tags: TagInfo[] = [
  { tag: "AI", count: 2, files: ["a.md", "b.md"] },
  { tag: "AI/机器学习", count: 1, files: ["b.md"] },
  { tag: "notes", count: 3, files: ["a.md", "c.md", "d.md"] },
];

let container: HTMLDivElement;
let root: Root;

function render(el: ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root.render(el); });
}

afterEach(() => {
  try { act(() => root.unmount()); } catch { /* 已卸载 */ }
  container?.remove();
});

describe("TagPanel", () => {
  it("列出全部标签与引用次数", () => {
    render(<TagPanel tags={tags} dark={false} onSelect={() => {}} onRefresh={() => {}} />);
    const text = container.textContent || "";
    expect(text).toContain("AI");
    expect(text).toContain("AI/机器学习");
    expect(text).toContain("notes");
    expect(text).toContain("2"); // AI 的 count
  });

  it("搜索框过滤标签", () => {
    render(<TagPanel tags={tags} dark={false} onSelect={() => {}} onRefresh={() => {}} />);
    const input = container.querySelector("input") as HTMLInputElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "机器");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const text = container.textContent || "";
    expect(text).toContain("AI/机器学习");
    expect(text).not.toContain("notes");
  });

  it("点击标签展开文件列表，点击文件触发 onSelect", () => {
    const opened: string[] = [];
    render(<TagPanel tags={tags} dark={false} onSelect={p => opened.push(p)} onRefresh={() => {}} />);
    // 展开 AI 标签：标签行是文本为 "AI2" 且含多个子元素的最深 div
    // （外层包装 div 文本相同但只有 1 个子节点，取 childElementCount 大者）
    const row = Array.from(container.querySelectorAll("div"))
      .filter(d => d.textContent === "AI2")
      .sort((a, b) => b.childElementCount - a.childElementCount)[0];
    act(() => { row!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(container.textContent).toContain("a.md");
    const fileRow = Array.from(container.querySelectorAll("div")).find(d => d.textContent === "a.md");
    act(() => { fileRow!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(opened).toEqual(["a.md"]);
  });

  it("空标签库显示提示", () => {
    render(<TagPanel tags={[]} dark={false} onSelect={() => {}} onRefresh={() => {}} />);
    expect(container.textContent).toContain("暂无标签");
  });
});
