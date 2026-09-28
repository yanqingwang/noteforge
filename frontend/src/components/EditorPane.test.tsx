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

// 取自 微信云托管部署清单-fde-jobs-2026-09-24.md 的真实结构（围栏代码块 + 表格 + 引用）
const DOC_WITH_FENCE = [
  "# 微信云托管部署清单 — fde-jobs（2026-09-24）",
  "",
  "> 目标：把 `code/fde-jobs/` 后端部署到**微信云托管**。",
  "",
  "## 一、控制台执行 SQL",
  "",
  "```sql",
  "CREATE DATABASE IF NOT EXISTS fde_jobs DEFAULT CHARACTER SET utf8mb4;",
  "CREATE USER IF NOT EXISTS 'fde_jobs'@'%' IDENTIFIED WITH mysql_native_password BY '<见 .secrets>';",
  "FLUSH PRIVILEGES;",
  "```",
  "",
  "## 三、环境变量",
  "",
  "```",
  "MYSQL_ADDRESS=10.34.102.54:3306",
  "FDE_SCRAPE_TOKEN=65f4dcbe24c3baa4e8afd6dac89ffd44",
  "```",
  "",
  "| 平台 | 入口 | 用途 |",
  "|---|---|---|",
  "| 微信云托管 | cloud.weixin.qq.com/cloudrun | fde-jobs 后端 |",
].join("\n");

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

  it("mode=live 挂载：多行围栏代码块渲染为代码块，不抛异常（空白屏回归）", () => {
    // 复现问题：打开「微信云托管部署清单-fde-jobs-2026-09-24.md」后整窗白屏。
    // 该文档含 ```sql / ``` 围栏代码块，live 模式曾用 block:false 的行内 widget
    // 替换跨行代码文本，CM6 抛 "Decorations that replace line breaks may not be
    // specified via plugins" → 编辑器（乃至整窗）渲染失败。
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    expect(() => {
      act(() => {
        root.render(
          <EditorPane content={DOC_WITH_FENCE} previewHtml="" activeFile="清单.md"
            mode="live" />,
        );
      });
    }).not.toThrow();

    const editor = container.querySelector(".cm-editor");
    expect(editor).toBeTruthy();
    // 代码块以 <pre class="lp-codeblock"> 形式渲染，且编辑器仍显示文档其余内容
    expect(editor!.querySelector("pre.lp-codeblock")).toBeTruthy();
    expect(editor!.textContent).toContain("控制台执行 SQL");

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
