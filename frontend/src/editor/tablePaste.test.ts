/**
 * 表格插入 / Excel 粘贴转换测试：
 * buildMarkdownRow / buildMarkdownTable / htmlToRows / tsvToRows / insertTableAt。
 */
import { describe, it, expect } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { nfExtensions } from "./extensions";
import { buildMarkdownRow, buildMarkdownTable, htmlToRows, tsvToRows, insertTableAt } from "./tableEdit";

function makeView(doc: string) {
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [
        markdown({ extensions: [GFM] }),
        ...nfExtensions({ live: false, lineNumbers: false, getFiles: () => [] }),
      ],
    }),
  });
  return view;
}

describe("buildMarkdownRow / buildMarkdownTable", () => {
  it("单行转义竖线与换行", () => {
    expect(buildMarkdownRow(["a|b", "x\ny"])).toBe("| a\\|b | x y |");
  });

  it("rows → 表头 + 对齐行 + 数据行；短行补空", () => {
    expect(buildMarkdownTable([["A", "B"], ["1"], ["2", "3"]])).toBe(
      "| A | B |\n| --- | --- |\n| 1 |  |\n| 2 | 3 |");
  });

  it("空数组返回空串", () => {
    expect(buildMarkdownTable([])).toBe("");
  });
});

describe("htmlToRows", () => {
  it("解析 table/th/td", () => {
    const rows = htmlToRows("<table><tr><th>列A</th><th>列B</th></tr><tr><td>1</td><td>2</td></tr></table>");
    expect(rows).toEqual([["列A", "列B"], ["1", "2"]]);
  });

  it("单元格内 HTML 标签取 textContent，&nbsp; 归一空格", () => {
    const rows = htmlToRows('<table><tr><td><b>粗</b>&nbsp;体</td></tr></table>');
    expect(rows).toEqual([["粗 体"]]);
  });

  it("无 table 返回 null", () => {
    expect(htmlToRows("<div>no table</div>")).toBeNull();
  });
});

describe("tsvToRows", () => {
  it("制表符分列", () => {
    expect(tsvToRows("A\tB\n1\t2")).toEqual([["A", "B"], ["1", "2"]]);
  });

  it("无制表符 → 不是表格", () => {
    expect(tsvToRows("普通文本\n第二行")).toBeNull();
  });

  it("空串 → null", () => {
    expect(tsvToRows("")).toBeNull();
  });
});

describe("insertTableAt", () => {
  it("在光标行后插入 rows×cols 表格", () => {
    const view = makeView("前言");
    insertTableAt(view, 3, 2);
    const doc = view.state.doc.toString();
    expect(doc).toContain("| 列1 | 列2 |");
    expect(doc).toContain("| --- | --- |");
    expect(doc.split("\n").filter(l => l.includes("|")).length).toBe(3);
    view.destroy();
  });

  it("行列数会被钳制", () => {
    const view = makeView("");
    insertTableAt(view, 999, 999);
    const cols = view.state.doc.line(1).text.split("|").length - 2;
    expect(cols).toBe(20); // 上限 20 列
    view.destroy();
  });
});
