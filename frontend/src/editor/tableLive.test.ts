/**
 * 即输即显的表格渲染测试（jsdom）：
 *  - 非光标行渲染成表格外观（行装饰 / 表头 / 竖线网格）
 *  - 对齐行 | --- | 隐藏成横线（--- 被替换掉，只留竖线标记）
 *  - 光标所在行回显源码（不做替换）
 *  - 单元格内容即原文，保证可直接在单元格里改数据（不产生额外装饰冲突）
 */
import { describe, it, expect } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { nfExtensions } from "./extensions";

const TABLE = [
  "| 平台 | 入口 | 用途 |",
  "| --- | :---: | ---: |",
  "| 微信云托管 | cloud.weixin.qq.com | fde-jobs 后端 |",
  "| 云开发 | tcb.cloud.tencent.com | 验证环境 |",
].join("\n");

function makeView(doc: string) {
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc,
      extensions: [
        markdown({ extensions: [GFM] }),
        ...nfExtensions({ live: true, lineNumbers: false, getFiles: () => [] }),
      ],
    }),
  });
  return view;
}

describe("live 模式表格渲染", () => {
  it("非光标行加表格行装饰与表头样式", () => {
    const view = makeView("段落\n\n" + TABLE);
    // 光标停在段落（表格之外）→ 整个表格按渲染态处理
    view.dispatch({ selection: { anchor: 1 } });
    const rows = document.querySelectorAll(".lp-trow");
    expect(rows.length).toBe(4);                       // 表头 + 对齐行 + 2 数据行
    expect(document.querySelectorAll(".lp-trow-head").length).toBe(1);
    expect(document.querySelectorAll(".lp-trow-last").length).toBe(1);
    // 竖线被淡化成网格线
    expect(document.querySelectorAll(".lp-tsep").length).toBeGreaterThan(8);
    // 单元格内容仍在文本里（可直接改数据）
    expect(view.state.doc.toString()).toContain("| 微信云托管 | cloud.weixin.qq.com | fde-jobs 后端 |");
    view.destroy();
  });

  it("对齐行：--- 被隐藏（渲染成横线），竖线保留", () => {
    const view = makeView(TABLE);
    view.dispatch({ selection: { anchor: 1 } });
    const delim = document.querySelector(".lp-trow-delim");
    expect(delim).toBeTruthy();
    // 该行文本仍可从 DOM 看到，但 --- 不应作为可见文本出现
    const rowText = delim!.closest(".cm-line")?.textContent ?? "";
    expect(rowText).not.toContain("---");
    view.destroy();
  });

  it("光标落在对齐行时回显 --- 源码", () => {
    const view = makeView(TABLE);
    const delimLine = view.state.doc.line(2);          // | --- | :---: | ---: |
    view.dispatch({ selection: { anchor: delimLine.from + 5 } });
    const rowText = document.querySelectorAll(".cm-line")[1]?.textContent ?? "";
    expect(rowText).toContain("---");
    view.destroy();
  });

  it("光标落在数据行时该行回显源码，其余行保持表格外观", () => {
    const view = makeView(TABLE);
    const dataLine = view.state.doc.line(3);
    view.dispatch({ selection: { anchor: dataLine.from + 4 } });
    const rows = document.querySelectorAll(".lp-trow");
    // 光标行不再有表格行装饰 → 少一行
    expect(rows.length).toBe(3);
    const text = document.querySelectorAll(".cm-line")[2]?.textContent ?? "";
    expect(text).toContain("| 微信云托管 |");
    view.destroy();
  });

  it("在单元格里改数据后文档同步更新（结构不变）", () => {
    const view = makeView(TABLE);
    const cell = view.state.doc.line(4);          // | 云开发 | tcb... | ... |
    const idx = cell.text.indexOf("云开发");
    expect(idx).toBeGreaterThan(-1);
    view.dispatch({ changes: { from: cell.from + idx, to: cell.from + idx + 3, insert: "腾讯云开发" } });
    expect(view.state.doc.toString()).toContain("| 腾讯云开发 |");
    // 管道符数量不变（表格结构没被破坏）
    expect((cell.text.match(/\|/g) || []).length).toBe(4);
    view.destroy();
  });

  it("含转义竖线 \\| 的单元格不会被拆错", () => {
    const view = makeView(["| A | B |", "| --- | --- |", "| a \\| b | c |"].join("\n"));
    expect(() => view.dispatch({ selection: { anchor: 1 } })).not.toThrow();
    expect(view.state.doc.toString()).toContain("a \\| b");
    view.destroy();
  });
});
