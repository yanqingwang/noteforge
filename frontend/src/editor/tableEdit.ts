/**
 * Markdown 表格编辑（表格工具条 + 单元格导航 + 行列增删）。
 *
 * 对标 Obsidian / Typora 的表格交互：
 *  - 鼠标：光标进入表格后，表格上方浮出一条工具条，点击增删行列；
 *  - 键盘：Tab / Shift-Tab 在单元格间移动（末格再 Tab 自动新增一行），
 *    Alt+↑/↓ 增行、Alt+Shift+↑/↓ 删行、Alt+←/→ 增列、Alt+Shift+←/→ 删列；
 *  - 增删列会同步修改表头、对齐行（| --- |）与所有数据行，保持表格合法。
 *
 * 表格识别：连续含 `|` 的行构成一块，且第二行必须是对齐行（仅 - : | 空格）。
 */
import { EditorView, ViewPlugin, keymap } from "@codemirror/view";
import { EditorSelection, Prec } from "@codemirror/state";
import type { EditorState, Extension } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";

// ── 解析 ─────────────────────────────────────────────────────────────

/** 单元格内容区间（不含两侧空白与 `|`） */
export interface Cell {
  from: number;
  to: number;
}

interface Row {
  /** 行号（1-based） */
  number: number;
  from: number;
  to: number;
  cells: Cell[];
  /** 是否为对齐行（| --- | --- |） */
  delim: boolean;
  /** 是否以 `|` 开头（决定新增列的写法） */
  leadPipe: boolean;
  /** 行首缩进长度 */
  indent: number;
}

export interface TableInfo {
  from: number;
  to: number;
  rows: Row[];
  /** 光标所在行在 rows 中的下标；不在表格内为 -1 */
  rowIndex: number;
  colIndex: number;
  colCount: number;
  canDeleteCol: boolean;
  canDeleteRow: boolean;
}

const DELIM_ONLY = /^[\s|:-]*-[\s|:-]*$/;

function isRowText(text: string): boolean {
  const t = text.trim();
  if (t === "" || !t.includes("|")) return false;
  if (t.startsWith("```")) return false; // 代码围栏不当作表格
  return true;
}

function isDelimText(text: string): boolean {
  const t = text.trim();
  return t.includes("-") && DELIM_ONLY.test(t);
}

function pipePositions(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "|" && (i === 0 || text[i - 1] !== "\\")) out.push(i);
  }
  return out;
}

/** 解析一行 → 单元格内容区间（doc 坐标） */
function parseCells(text: string, lineFrom: number): { cells: Cell[]; leadPipe: boolean; indent: number } {
  const pipes = pipePositions(text);
  const segs: Array<[number, number]> = [];
  let segStart = 0;
  let leadPipe = false;
  for (let k = 0; k < pipes.length; k++) {
    const p = pipes[k];
    if (k === 0 && text.slice(0, p).trim() === "") {
      leadPipe = true;
      segStart = p + 1;
      continue;
    }
    segs.push([segStart, p]);
    segStart = p + 1;
  }
  if (text.slice(segStart).trim() !== "") segs.push([segStart, text.length]);

  const cells: Cell[] = segs.map(([s, e]) => {
    let a = s;
    let b = e;
    while (a < b && (text[a] === " " || text[a] === "\t")) a++;
    while (b > a && (text[b - 1] === " " || text[b - 1] === "\t")) b--;
    return { from: lineFrom + a, to: lineFrom + b };
  });
  return { cells, leadPipe, indent: text.length - text.trimStart().length };
}

function parseRow(state: EditorState, number: number): Row | null {
  const line = state.doc.line(number);
  if (!isRowText(line.text)) return null;
  const { cells, leadPipe, indent } = parseCells(line.text, line.from);
  return { number, from: line.from, to: line.to, cells, delim: isDelimText(line.text), leadPipe, indent };
}

/** 光标是否在围栏代码块内（是则不提供表格操作） */
function insideCodeBlock(state: EditorState, pos: number): boolean {
  let node: SyntaxNode | null = null;
  try {
    node = syntaxTree(state).resolveInner(pos, -1);
  } catch {
    return false;
  }
  for (let n: SyntaxNode | null = node; n; n = n.parent) {
    if (n.name === "FencedCode" || n.name === "CodeBlock" || n.name === "CodeText") return true;
  }
  return false;
}

/** 找到 pos 所在的表格；不在表格内返回 null（导出供测试） */
export function findTableAt(state: EditorState, pos: number): TableInfo | null {
  const lineNo = state.doc.lineAt(pos).number;
  if (!isRowText(state.doc.line(lineNo).text)) return null;
  if (insideCodeBlock(state, pos)) return null;

  let start = lineNo;
  while (start > 1 && isRowText(state.doc.line(start - 1).text)) start--;
  let end = lineNo;
  while (end < state.doc.lines && isRowText(state.doc.line(end + 1).text)) end++;

  const rows: Row[] = [];
  for (let n = start; n <= end; n++) {
    const r = parseRow(state, n);
    if (!r) return null;
    rows.push(r);
  }
  // 第二行必须是对齐行，否则不是合法表格
  if (rows.length < 2 || !rows[1].delim) return null;

  const cur = rows.find((r) => r.number === lineNo)!;
  const rowIndex = rows.indexOf(cur);
  let colIndex = 0;
  for (let i = 0; i < cur.cells.length; i++) {
    if (pos <= cur.cells[i].to) {
      colIndex = i;
      break;
    }
    colIndex = i;
  }
  const colCount = rows[0].cells.length;
  return {
    from: rows[0].from,
    to: rows[rows.length - 1].to,
    rows,
    rowIndex,
    colIndex,
    colCount,
    canDeleteCol: colCount > 1,
    canDeleteRow: rows.length > 2,
  };
}

// ── 增删行列 ─────────────────────────────────────────────────────────

/** 新空行文本：沿用模板行的列数与缩进/首竖线风格 */
function emptyRowText(t: TableInfo, template: Row): string {
  const pad = " ".repeat(template.indent);
  const cells = Array.from({ length: t.colCount }, () => "").join(" | ");
  return template.leadPipe ? `${pad}| ${cells} |` : `${pad}${cells}`;
}

/** 对齐行新单元格的写法，跟随现有风格（`---` / `:---` / `:---:` / `---:`） */
function delimSample(state: EditorState, delimRow: Row): string {
  const c = delimRow.cells[0];
  if (!c) return "---";
  const text = state.sliceDoc(c.from, c.to).trim();
  return text.includes("-") ? text : "---";
}

function focusCell(view: EditorView, cell: Cell) {
  view.dispatch({ selection: EditorSelection.single(cell.to), scrollIntoView: true });
}

/** 在当前行上方 / 下方插入空行 */
export function insertRow(view: EditorView, where: "above" | "below"): boolean {
  const t = findTableAt(view.state, view.state.selection.main.head);
  if (!t) return false;
  // 对齐行不是数据行：以其相邻的数据行为基准
  let idx = t.rowIndex;
  if (t.rows[idx].delim) idx = Math.max(0, idx - 1);
  const anchor = t.rows[idx];
  const text = emptyRowText(t, anchor);
  const at = where === "above" ? anchor.from : anchor.to;
  const insert = where === "above" ? `${text}\n` : `\n${text}`;
  view.dispatch({ changes: { from: at, to: at, insert }, scrollIntoView: true });
  const line = view.state.doc.line(where === "above" ? anchor.number : anchor.number + 1);
  const parsed = parseCells(line.text, line.from);
  if (parsed.cells.length) focusCell(view, parsed.cells[0]);
  else view.dispatch({ selection: EditorSelection.single(line.from) });
  return true;
}

/** 删除当前数据行（表头与对齐行不可删） */
export function deleteRow(view: EditorView): boolean {
  const t = findTableAt(view.state, view.state.selection.main.head);
  if (!t || !t.canDeleteRow) return false;
  let idx = t.rowIndex;
  if (t.rows[idx].delim) idx -= 1;
  if (idx < 2) return false; // rows[0]=表头 rows[1]=对齐行
  const row = t.rows[idx];
  // 末行删除需连同上一行的换行符，否则会留下一个空行
  const from = row.number < view.state.doc.lines ? row.from : t.rows[idx - 1].to;
  const to = row.number < view.state.doc.lines ? row.to + 1 : row.to;
  const fallback = view.state.doc.line(t.rows[idx - 1].number);
  const fbParsed = parseCells(fallback.text, fallback.from);
  const keepCol = Math.min(t.colIndex, fbParsed.cells.length - 1);
  view.dispatch({ changes: { from, to }, scrollIntoView: true });
  if (fbParsed.cells.length) focusCell(view, fbParsed.cells[Math.max(0, keepCol)]);
  return true;
}

/** 在当前列左侧 / 右侧插入一列（表头、对齐行、数据行同步） */
export function insertCol(view: EditorView, where: "left" | "right"): boolean {
  const t = findTableAt(view.state, view.state.selection.main.head);
  if (!t) return false;
  const state = view.state;
  const j = where === "left" ? t.colIndex : t.colIndex + 1;
  const mark = delimSample(state, t.rows[1]);
  const changes: { from: number; to: number; insert: string }[] = [];

  for (const row of t.rows) {
    if (row.delim) {
      // 对齐行的新格必须含 '-'，否则表格失效
      if (where === "left") {
        const at = row.leadPipe ? row.from + row.indent + 1 : row.from + row.indent;
        changes.push({ from: at, to: at, insert: row.leadPipe ? ` ${mark} |` : `| ${mark} | ` });
      } else {
        changes.push({ from: row.to, to: row.to, insert: row.leadPipe ? ` ${mark} |` : ` | ${mark}` });
      }
    } else if (where === "left") {
      // 带首竖线：插到首竖线之后；无首竖线：插到行首
      const at = row.leadPipe ? row.from + row.indent + 1 : row.from + row.indent;
      changes.push({ from: at, to: at, insert: row.leadPipe ? "  |" : "| " });
    } else {
      changes.push({ from: row.to, to: row.to, insert: row.leadPipe ? "  |" : " |" });
    }
  }
  if (!changes.length) return false;
  view.dispatch({ changes, scrollIntoView: true });
  const header = view.state.doc.line(t.rows[0].number);
  const parsed = parseCells(header.text, header.from);
  if (parsed.cells.length > j) focusCell(view, parsed.cells[j]);
  return true;
}

/** 删除当前列（表头、对齐行、数据行同步） */
export function deleteCol(view: EditorView): boolean {
  const t = findTableAt(view.state, view.state.selection.main.head);
  if (!t || !t.canDeleteCol) return false;
  const j = t.colIndex;
  const changes: { from: number; to: number }[] = [];

  for (const row of t.rows) {
    if (row.cells.length <= 1) continue;
    if (j > 0) {
      // 去掉「前格内容末尾 → 本格内容末尾」：即分隔竖线 + 本格内容
      changes.push({ from: row.cells[j - 1].to, to: row.cells[j].to });
    } else {
      // 首列：只删「首列内容 + 紧随的竖线与空格」，保留行首竖线
      const from = row.leadPipe ? row.cells[0].from : row.from;
      changes.push({ from, to: row.cells[1].from });
    }
  }
  if (!changes.length) return false;
  const anchorRow = t.rows[0];
  view.dispatch({ changes, scrollIntoView: true });
  const header = view.state.doc.line(anchorRow.number);
  const parsed = parseCells(header.text, header.from);
  if (parsed.cells.length) focusCell(view, parsed.cells[Math.min(j, parsed.cells.length - 1)]);
  return true;
}

// ── 单元格导航（Tab / Shift-Tab）─────────────────────────────────────

/** 按阅读顺序列出可编辑单元格（跳过对齐行） */
function editableCells(t: TableInfo): Cell[] {
  const out: Cell[] = [];
  for (const row of t.rows) {
    if (row.delim) continue;
    for (const c of row.cells) out.push(c);
  }
  return out;
}

export function tableNavigate(view: EditorView, dir: 1 | -1): boolean {
  const t = findTableAt(view.state, view.state.selection.main.head);
  if (!t) return false;
  const cells = editableCells(t);
  if (!cells.length) return false;
  const head = view.state.selection.main.head;

  if (dir === 1) {
    for (const c of cells) {
      if (head < c.to) {
        focusCell(view, c);
        return true;
      }
    }
    // 末格再 Tab → 新增一行并进入新行首格
    return insertRow(view, "below");
  }
  for (let i = cells.length - 1; i >= 0; i--) {
    if (head > cells[i].from) {
      focusCell(view, cells[i]);
      return true;
    }
  }
  return false; // 首格前 Shift+Tab 交回默认行为
}

// ── 工具条（鼠标操作）────────────────────────────────────────────────

/**
 * 悬浮工具条。
 * 不用 decoration 承载：CM6 禁止插件提供块级装饰（RangeError: Block
 * decorations may not be specified via plugins），故由 ViewPlugin 直接把浮层
 * 挂到 view.dom 上，按 coordsAtPos 定位到当前表格上方。
 */
class TableFloater {
  private el: HTMLDivElement;
  private disposers: (() => void)[] = [];

  private view: EditorView;

  constructor(view: EditorView) {
    this.view = view;
    const el = document.createElement("div");
    el.className = "nf-table-bar";
    el.setAttribute("style", [
      "position:absolute", "z-index:20", "display:none", "align-items:center", "gap:2px",
      "padding:2px 4px", "background:#f2f3f5", "border:1px solid #e3e5e8", "border-radius:4px",
      "box-shadow:0 1px 3px rgba(0,0,0,0.12)", "font-size:11px", "line-height:1.6", "white-space:nowrap",
    ].join(";"));
    this.el = el;
    view.dom.appendChild(el);

    const onScroll = () => this.schedulePosition(view);
    view.scrollDOM.addEventListener("scroll", onScroll, { passive: true });
    this.disposers.push(() => view.scrollDOM.removeEventListener("scroll", onScroll));
  }

  /**
   * 读布局（coordsAtPos / offsetWidth）在 CM6 的 update 阶段会抛
   * "Reading the editor layout isn't allowed during an update"，并让整个插件
   * 被判崩溃销毁 —— 因此定位一律延后到下一帧。
   */
  private pending = 0;
  private schedulePosition(view: EditorView) {
    if (this.pending) return;
    const raf = typeof requestAnimationFrame === "function"
      ? requestAnimationFrame
      : (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number;
    this.pending = raf(() => {
      this.pending = 0;
      this.position(view);
    });
  }

  private position(view: EditorView) {
    if (this.el.dataset.active !== "1") return;
    const t = findTableAt(view.state, view.state.selection.main.head);
    if (!t) {
      this.el.style.display = "none";
      this.el.dataset.active = "";
      return;
    }
    const coords = view.coordsAtPos(t.from);
    const host = view.dom.getBoundingClientRect();
    if (!coords) {
      this.el.style.display = "none";
      return;
    }
    this.el.style.display = "flex";
    const w = this.el.offsetWidth || 220;
    const h = this.el.offsetHeight || 24;
    this.el.style.left = `${Math.max(0, Math.min(coords.left - host.left, Math.max(0, host.width - w)))}px`;
    this.el.style.top = `${Math.max(0, coords.top - host.top - h - 4)}px`;
  }

  private makeButton(label: string, title: string, run: () => void, disabled: boolean): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.title = title;
    b.className = "nf-table-btn";
    b.disabled = disabled;
    b.setAttribute("style", [
      "font-size:11px", "padding:0 6px", "border:1px solid transparent", "border-radius:3px",
      "background:transparent", `color:${disabled ? "#bbb" : "#444"}`, `cursor:${disabled ? "default" : "pointer"}`,
    ].join(";"));
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", (e) => {
      e.preventDefault();
      if (b.disabled) return;
      run();
      this.view.focus();
    });
    return b;
  }

  private sep(): HTMLSpanElement {
    const s = document.createElement("span");
    s.className = "nf-table-sep";
    s.setAttribute("style", "width:1px;height:14px;background:#d8dbde;margin:0 3px");
    return s;
  }

  update(view: EditorView) {
    const t = findTableAt(view.state, view.state.selection.main.head);
    if (!t) {
      this.el.style.display = "none";
      this.el.dataset.active = "";
      return;
    }
    this.el.dataset.active = "1";
    this.el.textContent = "";
    this.el.append(
      this.makeButton("＋行↑", "在表格上方插入一行（Alt+↑）", () => insertRow(view, "above"), false),
      this.makeButton("＋行↓", "在表格下方插入一行（Alt+↓）", () => insertRow(view, "below"), false),
      this.makeButton("－行", "删除当前行（Alt+Shift+↑ / ↓）", () => deleteRow(view), !t.canDeleteRow),
      this.sep(),
      this.makeButton("＋列←", "在左侧插入一列（Alt+←）", () => insertCol(view, "left"), false),
      this.makeButton("＋列→", "在右侧插入一列（Alt+→）", () => insertCol(view, "right"), false),
      this.makeButton("－列", "删除当前列（Alt+Shift+← / →）", () => deleteCol(view), !t.canDeleteCol),
    );

    this.schedulePosition(view);
  }

  destroy() {
    for (const d of this.disposers) d();
    this.el.remove();
  }
}

const tableToolbarPlugin = ViewPlugin.fromClass(
  class {
    floater: TableFloater;
    constructor(view: EditorView) {
      this.floater = new TableFloater(view);
      this.floater.update(view);
    }
    update(u: { view: EditorView }) {
      this.floater.update(u.view);
    }
    destroy() {
      this.floater.destroy();
    }
  },
);

/** 表格编辑扩展：悬浮工具条（鼠标）+ 快捷键（Prec.highest 压过 indentWithTab / 默认键位） */
export function tableEditing(): Extension {
  return [
    tableToolbarPlugin,
    Prec.highest(
      keymap.of([
        { key: "Tab", run: (v: EditorView) => tableNavigate(v, 1) },
        { key: "Shift-Tab", run: (v: EditorView) => tableNavigate(v, -1) },
        { key: "Alt-ArrowUp", run: (v: EditorView) => insertRow(v, "above") },
        { key: "Alt-ArrowDown", run: (v: EditorView) => insertRow(v, "below") },
        { key: "Alt-Shift-ArrowUp", run: (v: EditorView) => deleteRow(v) },
        { key: "Alt-Shift-ArrowDown", run: (v: EditorView) => deleteRow(v) },
        { key: "Alt-ArrowLeft", run: (v: EditorView) => insertCol(v, "left") },
        { key: "Alt-ArrowRight", run: (v: EditorView) => insertCol(v, "right") },
        { key: "Alt-Shift-ArrowLeft", run: (v: EditorView) => deleteCol(v) },
        { key: "Alt-Shift-ArrowRight", run: (v: EditorView) => deleteCol(v) },
      ]),
    ),
  ];
}
