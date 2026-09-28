/**
 * QuickSwitcher 组件测试：过滤目录/附件、键盘上下选择 + Enter 打开。
 */
import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactElement } from "react";
import QuickSwitcher from "./QuickSwitcher";

const files = [
  { path: "首页.md", is_dir: false },
  { path: "reports", is_dir: true },
  { path: "reports/单文件报告.html", is_dir: false },
  { path: "附件.png", is_dir: false },
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

describe("QuickSwitcher", () => {
  it("只列出可打开文件（排除目录与附件），含 .html", () => {
    render(<QuickSwitcher files={files} onSelect={() => {}} onClose={() => {}} />);
    const items = Array.from(container.querySelectorAll("div > div > div"))
      .map(d => d.textContent || "");
    expect(items.some(t => t.includes("首页.md"))).toBe(true);
    expect(items.some(t => t.includes("单文件报告.html"))).toBe(true);
    expect(items.some(t => t.includes("reports") && !t.includes(".html"))).toBe(false);
    expect(items.some(t => t.includes("附件.png"))).toBe(false);
  });

  it("输入过滤 + Enter 打开选中项（Obsidian 式键盘操作）", () => {
    const opened: string[] = [];
    render(<QuickSwitcher files={files} onSelect={p => opened.push(p)} onClose={() => {}} />);
    const input = container.querySelector("input") as HTMLInputElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "报告");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(opened).toEqual(["reports/单文件报告.html"]);
  });
});
