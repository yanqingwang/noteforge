/**
 * Markdown 表格编辑测试（jsdom）：
 * 表格识别、行列增删（表头/对齐行/数据行同步）、单元格导航、工具条渲染。
 */
import { describe, it, expect, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { nfExtensions } from "./extensions";
import { findTableAt, insertRow, deleteRow, insertCol, deleteCol, tableNavigate, tableEnter,
         columnAlignAt, setColumnAlign, cycleColumnAlign } from "./tableEdit";

const TABLE = [
  "| 列A | 列B |",
  "| --- | --- |",
  "| 1 | 2 |",
  "| 3 | 4 |",
].join("\n");

function makeView(doc: string) {
  return new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc,
      extensions: [
        markdown({ extensions: [GFM] }),
        ...nfExtensions({ live: false, lineNumbers: false, getFiles: () => [] }),
      ],
    }),
  });
}

/**
 * 把光标精确放到指定行的指定单元格末尾。
 * rowIndex/colIndex 均为 0-based（0=表头行/首列，1=对齐行）。
 */
function place(view: EditorView, lineText: string, colIndex: number, rowOffset = 0) {
  const lineNo = view.state.doc.toString().split("\n").findIndex((l) => l === lineText) + 1;
  const line = view.state.doc.line(lineNo);
  const t = findTableAt(view.state, line.from);
  if (!t) {
    // 非表格场景（如「无对齐行」用例）：光标放到行首
    view.dispatch({ selection: { anchor: line.from } });
    return;
  }
  const row = t.rows[rowOffset];
  const cell = row.cells[colIndex] ?? row.cells[row.cells.length - 1];
  view.dispatch({ selection: { anchor: cell.to } });
}

describe("findTableAt（表格识别）", () => {
  it("识别表头/对齐行/数据行并定位行列", () => {
    const view = makeView(TABLE);
    place(view, "| 1 | 2 |", 1, 2); // 数据第 1 行第 2 列
    const t = findTableAt(view.state, view.state.selection.main.head)!;
    expect(t).toBeTruthy();
    expect(t.rows).toHaveLength(4);
    expect(t.colCount).toBe(2);
    expect(t.rowIndex).toBe(2);
    expect(t.colIndex).toBe(1);
    expect(t.canDeleteRow).toBe(true);
    view.destroy();
  });

  it("无对齐行不算表格；围栏代码块内也不算", () => {
    const v1 = makeView("| a | b |\n| 1 | 2 |");
    place(v1, "| a | b |", 0, 0);
    expect(findTableAt(v1.state, v1.state.selection.main.head)).toBeNull();
    v1.destroy();

    const v2 = makeView("```\n| a | b |\n| --- | --- |\n| 1 | 2 |\n```");
    place(v2, "| 1 | 2 |", 0, 2);
    expect(findTableAt(v2.state, v2.state.selection.main.head)).toBeNull();
    v2.destroy();
  });

  it("普通段落不算表格", () => {
    const view = makeView("正文里有个 | 竖线但不构成表格。");
    view.dispatch({ selection: { anchor: 5 } });
    expect(findTableAt(view.state, 5)).toBeNull();
    view.destroy();
  });
});

describe("insertRow（增行）", () => {
  it("下方插入：新增行与表格列数一致，光标落在新行首格", () => {
    const view = makeView(TABLE);
    place(view, "| 1 | 2 |", 0, 2);
    expect(insertRow(view, "below")).toBe(true);
    const lines = view.state.doc.toString().split("\n");
    expect(lines).toEqual([
      "| 列A | 列B |", "| --- | --- |", "| 1 | 2 |", "|  |  |", "| 3 | 4 |",
    ]);
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(4);
    view.destroy();
  });

  it("上方插入：插到表头下方第一行之前", () => {
    const view = makeView(TABLE);
    place(view, "| 1 | 2 |", 0, 2);
    expect(insertRow(view, "above")).toBe(true);
    const lines = view.state.doc.toString().split("\n");
    expect(lines[2]).toBe("|  |  |");
    expect(lines[3]).toBe("| 1 | 2 |");
    view.destroy();
  });
});

describe("deleteRow（删行）", () => {
  it("删除当前数据行并保留列对齐", () => {
    const view = makeView(TABLE);
    place(view, "| 3 | 4 |", 0, 3);
    expect(deleteRow(view)).toBe(true);
    expect(view.state.doc.toString().split("\n")).toEqual([
      "| 列A | 列B |", "| --- | --- |", "| 1 | 2 |",
    ]);
    view.destroy();
  });

  it("表头行不可删除", () => {
    const view = makeView(TABLE);
    place(view, "| 列A | 列B |", 0, 0);
    expect(deleteRow(view)).toBe(false);
    view.destroy();
  });
});

describe("insertCol / deleteCol（增删列）", () => {
  it("右侧插入：表头/对齐行/数据行同步增加", () => {
    const view = makeView(TABLE);
    place(view, "| 1 | 2 |", 0, 2);
    expect(insertCol(view, "right")).toBe(true);
    const lines = view.state.doc.toString().split("\n");
    expect(lines[0]).toBe("| 列A | 列B |  |");
    expect(lines[1]).toBe("| --- | --- | --- |");
    expect(lines[2]).toBe("| 1 | 2 |  |");
    expect(lines[3]).toBe("| 3 | 4 |  |");
    view.destroy();
  });

  it("左侧插入：新列在最前", () => {
    const view = makeView(TABLE);
    place(view, "| 1 | 2 |", 0, 2);
    expect(insertCol(view, "left")).toBe(true);
    const lines = view.state.doc.toString().split("\n");
    expect(lines[0]).toBe("|  | 列A | 列B |");
    expect(lines[1]).toBe("| --- | --- | --- |");
    view.destroy();
  });

  it("删除中间列：每行同步去掉该列", () => {
    const view = makeView("| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |");
    place(view, "| A | B | C |", 1, 0);
    expect(deleteCol(view)).toBe(true);
    const lines = view.state.doc.toString().split("\n");
    expect(lines[0]).toBe("| A | C |");
    expect(lines[1]).toBe("| --- | --- |");
    expect(lines[2]).toBe("| 1 | 3 |");
    view.destroy();
  });

  it("删除首列不留多余空格", () => {
    const view = makeView("| A | B |\n| --- | --- |\n| 1 | 2 |");
    place(view, "| A | B |", 0, 0);
    expect(deleteCol(view)).toBe(true);
    expect(view.state.doc.toString().split("\n")[0]).toBe("| B |");
    view.destroy();
  });

  it("只有一列时不允许删列", () => {
    const view = makeView("| A |\n| --- |\n| 1 |");
    place(view, "| A |", 0, 0);
    expect(deleteCol(view)).toBe(false);
    view.destroy();
  });
});

describe("tableNavigate（Tab / Shift-Tab 单元格导航）", () => {
  it("Tab 依次进入下一格，跳过对齐行", () => {
    const view = makeView(TABLE);
    place(view, "| 列A | 列B |", 0, 0);
    expect(tableNavigate(view, 1)).toBe(true);
    expect(view.state.doc.lineAt(view.state.selection.main.head).text).toContain("列A");
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(1);
    expect(tableNavigate(view, 1)).toBe(true);
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(3);
    view.destroy();
  });

  it("导航进入新格时选中整格内容（直接输入即覆盖）", () => {
    const view = makeView(TABLE);
    place(view, "| 列A | 列B |", 0, 0);
    tableNavigate(view, 1);
    const sel = view.state.selection.main;
    expect(view.state.sliceDoc(sel.from, sel.to)).toBe("列B");
    view.destroy();
  });

  it("格中部 Tab 前进到下一格（原实现卡在同一格）", () => {
    const view = makeView(TABLE);
    const line = view.state.doc.line(1);        // | 列A | 列B |
    const a = line.text.indexOf("列A");
    view.dispatch({ selection: { anchor: line.from + a + 1 } }); // 列A 中部
    expect(tableNavigate(view, 1)).toBe(true);
    const sel = view.state.selection.main;
    expect(view.state.sliceDoc(sel.from, sel.to)).toBe("列B");
    view.destroy();
  });

  it("Shift+Tab 后退到上一格（原实现卡在同一格）", () => {
    const view = makeView(TABLE);
    place(view, "| 1 | 2 |", 0, 2);             // 数据行1 col0 末尾
    expect(tableNavigate(view, -1)).toBe(true);
    const sel = view.state.selection.main;
    expect(view.state.doc.lineAt(sel.head).number).toBe(1);
    expect(view.state.sliceDoc(sel.from, sel.to)).toBe("列B");
    // 再退一格 → 列A
    expect(tableNavigate(view, -1)).toBe(true);
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe("列A");
    view.destroy();
  });

  it("末格再 Tab 自动新增一行并进入新格", () => {
    const view = makeView(TABLE);
    place(view, "| 3 | 4 |", 1, 3);
    expect(tableNavigate(view, 1)).toBe(true);
    const lines = view.state.doc.toString().split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[4]).toBe("|  |  |");
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(5);
    view.destroy();
  });

  it("非表格内 Tab 交回默认行为（返回 false）", () => {
    const view = makeView("普通段落");
    view.dispatch({ selection: { anchor: 2 } });
    expect(tableNavigate(view, 1)).toBe(false);
    view.destroy();
  });
});

describe("tableEnter（Enter 行为）", () => {
  it("非末行 Enter：移到下一行同列并选中内容", () => {
    const view = makeView(TABLE);
    place(view, "| 1 | 2 |", 0, 2);             // 数据行1 col0
    expect(tableEnter(view)).toBe(true);
    const sel = view.state.selection.main;
    expect(view.state.doc.lineAt(sel.head).number).toBe(4);
    expect(view.state.sliceDoc(sel.from, sel.to)).toBe("3");
    view.destroy();
  });

  it("对齐行下方 Enter：跳过对齐行落到下一数据行", () => {
    const view = makeView(TABLE);
    place(view, "| --- | --- |", 0, 1);
    expect(tableEnter(view)).toBe(true);
    const sel = view.state.selection.main;
    expect(view.state.doc.lineAt(sel.head).number).toBe(3);
    view.destroy();
  });

  it("末行 Enter：新建行并进入同列", () => {
    const view = makeView(TABLE);
    place(view, "| 3 | 4 |", 1, 3);             // 末行 col1
    expect(tableEnter(view)).toBe(true);
    const lines = view.state.doc.toString().split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[4]).toBe("|  |  |");
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(5);
    const t = findTableAt(view.state, view.state.selection.main.head)!;
    expect(t.colIndex).toBe(1);                  // 同列
    view.destroy();
  });

  it("有选区时不接管（交回默认替换）", () => {
    const view = makeView(TABLE);
    const line = view.state.doc.line(3);
    view.dispatch({ selection: { anchor: line.from + 2, head: line.from + 3 } });
    expect(tableEnter(view)).toBe(false);
    view.destroy();
  });
});

describe("自动对齐（输入暂停 / 离开表格）", () => {
  it("输入停顿 350ms 后整表自动对齐，光标保留", () => {
    vi.useFakeTimers();
    try {
      const view = makeView(TABLE);
      const line = view.state.doc.line(3);      // | 1 | 2 |
      const p = line.text.indexOf("1");
      const insert = "很长很长";
      // 模拟真实输入：文本变化 + 光标落在输入点之后
      view.dispatch({
        changes: { from: line.from + p, to: line.from + p + 1, insert },
        selection: { anchor: line.from + p + insert.length },
      });
      expect(view.state.doc.toString()).toContain("| 很长很长 | 2 |"); // 尚未对齐
      vi.advanceTimersByTime(400);
      const lines = view.state.doc.toString().split("\n");
      expect(lines[2]).toBe("| 很长很长 | 2   |");
      expect(lines[0]).toBe("| 列A   | 列B  |");
      expect(lines[1]).toBe("| ---- | --- |");
      // 光标仍停在输入的单元格内（按 行/列/格内偏移 映射，不被吸到表尾）
      expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(3);
      expect(view.state.sliceDoc(view.state.selection.main.head - 2, view.state.selection.main.head)).toBe("很长");
      view.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("光标移出表格时立即对齐", async () => {
    const view = makeView("段落\n\n" + TABLE);
    const t = findTableAt(view.state, 10)!;
    view.dispatch({ selection: { anchor: t.from + 2 } });    // 进入表格
    view.dispatch({ selection: { anchor: 1 } });             // 移出 → 排队对齐
    await new Promise<void>(r => queueMicrotask(r));         // 等延后一拍的 dispatch
    const lines = view.state.doc.toString().split("\n");
    expect(lines[2]).toBe("| 列A  | 列B  |");
    expect(lines[4]).toBe("| 1   | 2   |");
    view.destroy();
  });
});

describe("表格工具条稳定性（DOM 一次构建）", () => {
  it("光标在单元格间移动时按钮 DOM 不重建", () => {
    const view = makeView(TABLE);
    place(view, "| 1 | 2 |", 0, 2);
    const b1 = [...view.dom.querySelectorAll(".nf-table-btn")] as HTMLButtonElement[];
    place(view, "| 3 | 4 |", 1, 3);
    const b2 = [...view.dom.querySelectorAll(".nf-table-btn")] as HTMLButtonElement[];
    expect(b1.length).toBe(b2.length);
    expect(b2.length).toBeGreaterThan(0);
    expect(b1[0]).toBe(b2[0]);
    expect(b1[b1.length - 1]).toBe(b2[b2.length - 1]);
    view.destroy();
  });
});

describe("表格工具条（鼠标操作）", () => {
  it("光标进入表格后显示工具条按钮，段落中隐藏", () => {
    const view = makeView("段落\n\n" + TABLE);
    let bar = view.dom.querySelector(".nf-table-bar") as HTMLElement;
    expect(bar).toBeTruthy();
    expect(bar.dataset.active).toBe("");
    place(view, "| 1 | 2 |", 0, 2);
    bar = view.dom.querySelector(".nf-table-bar") as HTMLElement;
    expect(bar.dataset.active).toBe("1");
    const labels = [...bar.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).toEqual(["＋行↑", "＋行↓", "－行", "＋列←", "＋列→", "－列", "对齐:左", "⇔"]);
    view.destroy();
  });

  it("点击工具条「＋行↓」按钮即插入一行（鼠标路径）", () => {
    const view = makeView(TABLE);
    place(view, "| 1 | 2 |", 0, 2);
    const btns = [...view.dom.querySelectorAll(".nf-table-btn")] as HTMLButtonElement[];
    btns.find((b) => b.textContent === "＋行↓")!.click();
    expect(view.state.doc.toString().split("\n")).toContain("|  |  |");
    view.destroy();
  });

  it("仅表头+对齐行时禁用删行", () => {
    const view = makeView("| A | B |\n| --- | --- |");
    place(view, "| A | B |", 0, 0);
    const del = [...view.dom.querySelectorAll(".nf-table-btn")]
      .find((b) => b.textContent === "－行") as HTMLButtonElement;
    expect(del.disabled).toBe(true);
    view.destroy();
  });
});

describe("列对齐（markdown 对齐行）", () => {
  const AL = ["| A | B | C |", "| --- | :---: | ---: |", "| 1 | 2 | 3 |"].join("\n");

  it("读取当前列对齐：左 / 中 / 右", () => {
    const view = makeView(AL);
    place(view, "| A | B | C |", 0, 0);
    expect(columnAlignAt(view)).toBe("left");
    place(view, "| A | B | C |", 1, 0);
    expect(columnAlignAt(view)).toBe("center");
    place(view, "| A | B | C |", 2, 0);
    expect(columnAlignAt(view)).toBe("right");
    view.destroy();
  });

  it("设置对齐只改对齐行那一格", () => {
    const view = makeView(AL);
    place(view, "| A | B | C |", 0, 0);
    expect(setColumnAlign(view, "center")).toBe(true);
    expect(view.state.doc.toString().split("\n")[1]).toBe("| :---: | :---: | ---: |");
    expect(setColumnAlign(view, "right")).toBe(true);
    expect(view.state.doc.toString().split("\n")[1]).toBe("| ---: | :---: | ---: |");
    expect(setColumnAlign(view, "left")).toBe(true);
    expect(view.state.doc.toString().split("\n")[1]).toBe("| --- | :---: | ---: |");
    view.destroy();
  });

  it("保留原有虚线宽度", () => {
    const view = makeView(["| A |", "| ----- |", "| 1 |"].join("\n"));
    place(view, "| A |", 0, 0);
    setColumnAlign(view, "center");
    expect(view.state.doc.toString().split("\n")[1]).toBe("| :-----: |");
    view.destroy();
  });

  it("循环：左 → 中 → 右 → 左", () => {
    const view = makeView(AL);
    place(view, "| A | B | C |", 0, 0);
    cycleColumnAlign(view);
    expect(columnAlignAt(view)).toBe("center");
    cycleColumnAlign(view);
    expect(columnAlignAt(view)).toBe("right");
    cycleColumnAlign(view);
    expect(columnAlignAt(view)).toBe("left");
    view.destroy();
  });

  it("非表格内不生效", () => {
    const view = makeView("段落");
    view.dispatch({ selection: { anchor: 2 } });
    expect(setColumnAlign(view, "center")).toBe(false);
    expect(cycleColumnAlign(view)).toBe(false);
    view.destroy();
  });

  it("工具条「对齐」按钮显示当前对齐并可点击循环", () => {
    const view = makeView(AL);
    place(view, "| A | B | C |", 1, 0);
    const bar = view.dom.querySelector(".nf-table-bar") as HTMLElement;
    const btn = [...bar.querySelectorAll<HTMLButtonElement>(".nf-table-btn")]
      .find(b => b.textContent?.startsWith("对齐"))!;
    expect(btn.textContent).toBe("对齐:中");
    btn.click();
    expect(columnAlignAt(view)).toBe("right");
    const btn2 = [...(view.dom.querySelector(".nf-table-bar") as HTMLElement)
      .querySelectorAll<HTMLButtonElement>(".nf-table-btn")]
      .find(b => b.textContent?.startsWith("对齐"))!;
    expect(btn2.textContent).toBe("对齐:右");
    view.destroy();
  });
});
