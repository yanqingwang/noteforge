/**
 * FileTree 组件测试：默认折叠（类 Obsidian）、批量展开/折叠、
 * HTML 文件可见、打开文件自动展开祖先目录、按 vault 持久化。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactElement } from "react";
import FileTree from "./FileTree";
import type { FileEntry } from "../App";

const VAULT = "/tmp/vault-ft-test";

const files: FileEntry[] = [
  { path: "首页.md", is_dir: false, size: 10, modified: 5 },
  { path: "reports", is_dir: true, size: 0, modified: 4 },
  { path: "reports/单文件报告.html", is_dir: false, size: 20, modified: 3 },
  { path: "项目B", is_dir: true, size: 0, modified: 2 },
  { path: "项目B/子目录", is_dir: true, size: 0, modified: 1 },
  { path: "项目B/子目录/深层笔记.md", is_dir: false, size: 5, modified: 1 },
  { path: "附件.png", is_dir: false, size: 9, modified: 0 }, // 非可渲染文件不入树
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
  localStorage.clear();
});

describe("FileTree 默认折叠 + 批量操作", () => {
  beforeEach(() => localStorage.clear());

  it("默认全部折叠：目录行在、文件行不在", () => {
    render(<FileTree files={files} activeFile="" onSelect={() => {}} vaultPath={VAULT} />);
    expect(container.querySelector('[data-nf-dir="项目B"]')).toBeTruthy();
    expect(container.querySelector('[data-nf-dir="reports"]')).toBeTruthy();
    expect(container.querySelector('[data-nf-file="单文件报告.html"]')).toBeNull();
    expect(container.querySelector('[data-nf-file="深层笔记.md"]')).toBeNull();
  });

  it("展开全部 → 全部文件可见（含 .html）；折叠全部 → 收回", () => {
    render(<FileTree files={files} activeFile="" onSelect={() => {}} vaultPath={VAULT} />);
    const btns = Array.from(container.querySelectorAll("button"));
    act(() => { (btns.find(b => b.textContent === "展开全部") as HTMLButtonElement).click(); });
    expect(container.querySelector('[data-nf-file="单文件报告.html"]')).toBeTruthy();
    expect(container.querySelector('[data-nf-file="深层笔记.md"]')).toBeTruthy();
    expect(container.querySelector('[data-nf-file="首页.md"]')).toBeTruthy();
    // 附件不入树
    expect(container.querySelector('[data-nf-file="附件.png"]')).toBeNull();

    const btns2 = Array.from(container.querySelectorAll("button"));
    act(() => { (btns2.find(b => b.textContent === "折叠全部") as HTMLButtonElement).click(); });
    expect(container.querySelector('[data-nf-file="单文件报告.html"]')).toBeNull();
    expect(container.querySelector('[data-nf-file="深层笔记.md"]')).toBeNull();
    // 根级文件不受折叠影响（类 Obsidian）
    expect(container.querySelector('[data-nf-file="首页.md"]')).toBeTruthy();
  });

  it("点击单个目录可展开/收起", () => {
    render(<FileTree files={files} activeFile="" onSelect={() => {}} vaultPath={VAULT} />);
    const dir = container.querySelector('[data-nf-dir="项目B"]') as HTMLElement;
    act(() => { dir.click(); });
    expect(container.querySelector('[data-nf-dir="子目录"]')).toBeTruthy();
    act(() => { (container.querySelector('[data-nf-dir="项目B"]') as HTMLElement).click(); });
    expect(container.querySelector('[data-nf-dir="子目录"]')).toBeNull();
  });

  it("打开文件时自动展开其祖先目录（类 Obsidian）", () => {
    render(<FileTree files={files} activeFile="项目B/子目录/深层笔记.md" onSelect={() => {}} vaultPath={VAULT} />);
    expect(container.querySelector('[data-nf-file="深层笔记.md"]')).toBeTruthy();
    expect(container.querySelector('[data-nf-dir="项目B"]')).toBeTruthy();
  });

  it("展开状态按 vault 持久化", () => {
    render(<FileTree files={files} activeFile="" onSelect={() => {}} vaultPath={VAULT} />);
    const btns = Array.from(container.querySelectorAll("button"));
    act(() => { (btns.find(b => b.textContent === "展开全部") as HTMLButtonElement).click(); });
    const saved = JSON.parse(localStorage.getItem(`nf-expanded:${VAULT}`) || "[]");
    expect(saved).toContain("reports");
    expect(saved).toContain("项目B");
    expect(saved).toContain("项目B/子目录");

    // 重新挂载时读取持久化状态 → 保持展开
    act(() => { root.unmount(); });
    container.remove();
    render(<FileTree files={files} activeFile="" onSelect={() => {}} vaultPath={VAULT} />);
    expect(container.querySelector('[data-nf-file="单文件报告.html"]')).toBeTruthy();
  });

  it("HTML 文件点击回调其路径（可打开查看器）", () => {
    const onSelect = viFn();
    render(<FileTree files={files} activeFile="" onSelect={onSelect} vaultPath={VAULT} />);
    const btns = Array.from(container.querySelectorAll("button"));
    act(() => { (btns.find(b => b.textContent === "展开全部") as HTMLButtonElement).click(); });
    act(() => { (container.querySelector('[data-nf-file="单文件报告.html"]') as HTMLElement).click(); });
    expect(onSelect.calls).toEqual(["reports/单文件报告.html"]);
  });
});

// 极简 mock 函数（避免引入额外依赖）
function viFn() {
  const f: any = (...args: any[]) => { f.calls.push(args[0]); };
  f.calls = [] as any[];
  return f;
}
