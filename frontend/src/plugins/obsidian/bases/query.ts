/**
 * 查询引擎：把一个 .base 配置在一个 vault 上跑出结果集。
 *
 * 官方语义（obsidian.md/help/bases/syntax）：
 * - 默认数据集是**整个 vault**（没有 from/source 的概念）
 * - 全局 filters 与视图级 filters 求值时按 AND 拼接
 * - 公式可以引用其它公式（`formula.ppu`），但不能循环引用
 * - `sort` 多键排序、`groupBy` 单属性分组、`limit` 截断
 * - 汇总公式里 `values` 是该属性在**结果集**里的全部取值
 */

import { compareValues, type EvalScope } from "./expr/functions";
import { evalExpr, filePropertyValue } from "./expr/evaluate";
import type { FileApi } from "./expr/file-api";
import { DateValue, FileValue, fromJs, ListValue, NULL, NumberValue, Value } from "./expr/values";
import { normalizePropertyId, parsePropertyId, type BasesConfigFile, type BasesConfigFileFilter, type BasesConfigFileView, type BasesPropertyId } from "./config";

/** 一行（一篇文件）在某个 base 里的取值环境 */
export interface QueryRow {
  path: string;
  /** 公式求值作用域（note/formula/file 都在这里解析） */
  scope: EvalScope;
  /** 已算出的公式缓存（按属性 ID） */
  formulas: Map<string, Value>;
  /** 求值出错时记下来，UI 可以显示但不中断整表 */
  errors: string[];
}

export interface QueryOptions {
  config: BasesConfigFile;
  fileApi: FileApi;
  /** vault 里的全部文件（候选数据集） */
  files: string[];
  /** `this` 指谁：主区打开时是 .base 文件本身；嵌入时是宿主笔记 */
  selfPath: string;
}

export interface QueryOutcome {
  rows: QueryRow[];
  /** 全局 + 视图级筛选后的结果（未排序、未截断），汇总要基于它 */
  matched: QueryRow[];
  /** 所有可用属性 ID（note 属性 ∪ file 属性 ∪ 公式） */
  allProperties: BasesPropertyId[];
  errors: string[];
}

/** `file.*` 的属性 ID 集合（官方语法页列的 file properties） */
export const FILE_PROPERTIES: BasesPropertyId[] = [
  "file.backlinks",
  "file.ctime",
  "file.embeds",
  "file.ext",
  "file.file",
  "file.folder",
  "file.links",
  "file.mtime",
  "file.name",
  "file.path",
  "file.properties",
  "file.size",
  "file.tags",
];

/** 取属性 ID 在某行的取值。未知属性给空值而不是抛（某些行可能没这个属性）。 */
export function propertyValue(row: QueryRow, propertyId: BasesPropertyId): Value {
  const key = normalizePropertyId(propertyId);
  const cached = row.formulas.get(key);
  if (cached) return cached;
  const { type, name } = parsePropertyId(key);
  // file.* 要取具体那个属性（file.name / file.mtime…），不是拿 FileValue 当答案
  if (type === "file") return filePropertyValue(row.path, name, row.scope.fileApi);
  if (type === "formula") return row.scope.formula(name) ?? NULL;
  return row.scope.noteProp(name);
}

/** 求一个 .base 在某个视图下的结果集 */
export function runQuery(opts: QueryOptions, view: BasesConfigFileView): QueryOutcome {
  const { config, fileApi, files, selfPath } = opts;
  const errors: string[] = [];

  // 公式：先编译，循环引用在这里被发现（而不是每行都重算才发现）
  const formulaNames = Object.keys(config.formulas ?? {});
  const formulaSrc = new Map<string, string>();
  for (const name of formulaNames) formulaSrc.set(name, config.formulas?.[name] ?? "");

  const globalFilter = config.filters;
  const viewFilter = view.filters;
  const filters = combineFilters(globalFilter, viewFilter);

  // 公式环要在跑之前查出来：否则每一行都会重复失败，日志里全是同一个环
  const cycles = detectFormulaCycles(formulaSrc);
  for (const cycle of cycles) errors.push(`公式循环引用：${cycle.join(" → ")}`);
  const cyclic = new Set<string>();
  for (const cycle of cycles) for (const n of cycle) cyclic.add(n);

  const matched: QueryRow[] = [];
  const noteProps = new Set<string>();

  for (const path of files) {
    const row = makeRow(path, selfPath, fileApi, formulaSrc, cyclic);
    row.errors.length = 0;
    for (const k of Object.keys(fileApi.properties(path))) noteProps.add(k);
    let keep = true;
    if (filters && !evaluateFilter(filters, row, errors)) keep = false;
    if (keep) matched.push(row);
    // 收集错误但只留前若干条，避免一个坏公式刷屏
    for (const e of row.errors) {
      if (errors.length < 50) errors.push(`${path}：${e}`);
    }
  }

  // 排序（多键）
  const sorts = view.sort ?? [];
  const sorted = sorts.length ? sortRows(matched, sorts) : matched;

  // 截断
  const rows = view.limit && view.limit > 0 ? sorted.slice(0, view.limit) : sorted;

  // 可用属性：file.* + note 属性 + 公式
  const allProperties = new Set<BasesPropertyId>(FILE_PROPERTIES);
  for (const p of noteProps) allProperties.add(`note.${p}`);
  for (const f of formulaNames) allProperties.add(`formula.${f}`);
  for (const o of view.order ?? []) allProperties.add(normalizePropertyId(o));

  return { rows, matched: sorted, allProperties: [...allProperties], errors };
}

function makeRow(
  path: string,
  selfPath: string,
  fileApi: FileApi,
  formulaSrc: Map<string, string>,
  cyclic: Set<string>,
): QueryRow {
  const formulaCache = new Map<string, Value>();
  const errors: string[] = [];
  const computing = new Set<string>();

  const scope: EvalScope = {
    file: new FileValue(path),
    noteProp: (name) => fromJs(fileApi.properties(path)[name]),
    formula: (name) => {
      const key = normalizePropertyId(`formula.${name}`);
      const hit = formulaCache.get(key);
      if (hit) return hit;
      const src = formulaSrc.get(name);
      if (src === undefined) return null;
      if (cyclic.has(name)) {
        const v = NULL;
        formulaCache.set(key, v);
        return v;
      }
      if (computing.has(name)) {
        // 运行时才发现的环（自定义函数间接引用）：记一次并给空值
        if (!errors.some((e) => e.includes("循环"))) errors.push(`公式循环引用：${name}`);
        const v = NULL;
        formulaCache.set(key, v);
        return v;
      }
      computing.add(name);
      try {
        const v = evalExpr(src, scope);
        formulaCache.set(key, v);
        return v;
      } catch (e) {
        errors.push(`formula.${name}: ${e instanceof Error ? e.message : String(e)}`);
        const v = NULL;
        formulaCache.set(key, v);
        return v;
      } finally {
        computing.delete(name);
      }
    },
    self: () => new FileValue(selfPath),
    fileApi,
  };
  return { path, scope, formulas: formulaCache, errors };
}

/** 全局 filters 与视图 filters 按 AND 拼接（官方明确） */
export function combineFilters(
  a: BasesConfigFileFilter | undefined,
  b: BasesConfigFileFilter | undefined,
): BasesConfigFileFilter | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return { and: [a, b] };
}

/** 递归求值 filter：字符串是表达式，{and|or|not} 是逻辑组合 */
export function evaluateFilter(filter: BasesConfigFileFilter, row: QueryRow, errors: string[]): boolean {
  if (typeof filter === "string") {
    try {
      return evalExpr(filter, row.scope).isTruthy();
    } catch (e) {
      if (errors.length < 50) errors.push(`筛选表达式「${filter}」出错：${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }
  if (Array.isArray(filter.and)) return filter.and.every((f) => evaluateFilter(f, row, errors));
  if (Array.isArray(filter.or)) {
    if (filter.or.length === 0) return true;
    return filter.or.some((f) => evaluateFilter(f, row, errors));
  }
  if (Array.isArray(filter.not)) return filter.not.every((f) => !evaluateFilter(f, row, errors));
  return true;
}

/** 多键排序：逐个 sort 比，前一个相等才看下一个 */
export function sortRows(rows: QueryRow[], sorts: { property: string; direction: "ASC" | "DESC" }[]): QueryRow[] {
  const sorted = [...rows];
  sorted.sort((ra, rb) => {
    for (const s of sorts) {
      const a = propertyValue(ra, s.property);
      const b = propertyValue(rb, s.property);
      const c = compareValues(a, b);
      if (c !== 0) return s.direction === "DESC" ? -c : c;
    }
    return 0;
  });
  return sorted;
}

/** 公式环检测：DFS 找回到自己的路径 */
function detectFormulaCycles(src: Map<string, string>): string[][] {
  const deps = new Map<string, string[]>();
  for (const [name, text] of src) {
    const found = new Set<string>();
    const re = /\bformula\.([A-Za-z_$][\w$]*)/g;
    let m: RegExpExecArray | null;
    // 自引用（a 里写 formula.a）也算环，所以不排除 name 自己
    while ((m = re.exec(text))) found.add(m[1]);
    deps.set(name, [...found]);
  }
  const cycles: string[][] = [];
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const visit = (n: string): void => {
    state.set(n, 1);
    stack.push(n);
    for (const d of deps.get(n) ?? []) {
      if (!src.has(d)) continue;
      const st = state.get(d) ?? 0;
      if (st === 0) visit(d);
      else if (st === 1) {
        const i = stack.indexOf(d);
        cycles.push([...stack.slice(i), d]);
      }
    }
    stack.pop();
    state.set(n, 2);
  };
  for (const n of src.keys()) if ((state.get(n) ?? 0) === 0) visit(n);
  return cycles;
}

/** 汇总：默认汇总公式 + 自定义（config.summaries） */
export function summaryValue(
  key: string,
  rows: QueryRow[],
  propertyId: BasesPropertyId,
  custom: Record<string, string> | undefined,
  fileApi: FileApi,
  selfPath: string,
): Value {
  const values = rows.map((r) => propertyValue(r, propertyId));
  const customSrc = custom?.[key];
  if (customSrc) {
    // 自定义汇总公式里 values 是该属性在结果集里的全部取值
    const anyPath = rows[0]?.path ?? selfPath;
    const scope: EvalScope = {
      file: new FileValue(anyPath),
      noteProp: () => NULL,
      formula: () => null,
      self: () => new FileValue(selfPath),
      fileApi,
      values: new ListValue(values),
    };
    try {
      return evalExpr(customSrc, scope);
    } catch (e) {
      // 汇总公式写错不该让整表崩：给空值，错误由调用方另行提示
      return NULL;
    }
  }
  return defaultSummary(key, values);
}

/** 官方 Bases syntax 页列的默认汇总公式 */
export function defaultSummary(key: string, values: Value[]): Value {
  const nonEmpty = values.filter((v) => !v.isEmpty());
  const numbers = nonEmpty.filter((v) => typeof v.primitive() === "number").map((v) => v.primitive() as number);
  const dates = nonEmpty.filter((v) => v.primitive() instanceof Date).map((v) => (v.primitive() as Date).getTime());
  switch (key.toLowerCase()) {
    case "average":
      return numbers.length ? new NumberValue(numbers.reduce((a, b) => a + b, 0) / numbers.length) : NULL;
    case "min":
      return numbers.length ? new NumberValue(Math.min(...numbers)) : dates.length ? new DateValue(new Date(Math.min(...dates))) : NULL;
    case "max":
      return numbers.length ? new NumberValue(Math.max(...numbers)) : dates.length ? new DateValue(new Date(Math.max(...dates))) : NULL;
    case "sum":
      return new NumberValue(numbers.reduce((a, b) => a + b, 0));
    case "range": {
      if (dates.length) return new NumberValue(Math.max(...dates) - Math.min(...dates));
      return numbers.length ? new NumberValue(Math.max(...numbers) - Math.min(...numbers)) : NULL;
    }
    case "median": {
      if (!numbers.length) return NULL;
      const s = [...numbers].sort((a, b) => a - b);
      const mid = Math.floor(s.length / 2);
      return new NumberValue(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
    }
    case "stddev": {
      if (numbers.length < 2) return new NumberValue(0);
      const m = numbers.reduce((a, b) => a + b, 0) / numbers.length;
      return new NumberValue(Math.sqrt(numbers.reduce((a, b) => a + (b - m) ** 2, 0) / numbers.length));
    }
    case "earliest":
      return dates.length ? new DateValue(new Date(Math.min(...dates))) : NULL;
    case "latest":
      return dates.length ? new DateValue(new Date(Math.max(...dates))) : NULL;
    case "checked":
      return new NumberValue(nonEmpty.filter((v) => v.primitive() === true).length);
    case "unchecked":
      return new NumberValue(nonEmpty.filter((v) => v.primitive() === false).length);
    case "empty":
      return new NumberValue(values.filter((v) => v.isEmpty()).length);
    case "filled":
      return new NumberValue(nonEmpty.length);
    case "unique":
      return new NumberValue(new Set(nonEmpty.map((v) => v.toString())).size);
    default:
      // 未知名字 → 空值（视图里显示空白，而不是假装算了个数）
      return NULL;
  }
}

/** 官方默认汇总公式的名字（工具栏「汇总」菜单用） */
export const DEFAULT_SUMMARIES = [
  "Average",
  "Min",
  "Max",
  "Sum",
  "Range",
  "Median",
  "Stddev",
  "Earliest",
  "Latest",
  "Checked",
  "Unchecked",
  "Empty",
  "Filled",
  "Unique",
] as const;

/** 未指定 order 时给一组能用的默认列（Obsidian 也这么干：先显示文件名与修改时间） */
export function defaultOrder(allProperties: BasesPropertyId[]): BasesPropertyId[] {
  const out: BasesPropertyId[] = ["file.name"];
  if (allProperties.includes("file.mtime")) out.push("file.mtime");
  const notes = allProperties.filter((p) => p.startsWith("note.")).sort();
  out.push(...notes.slice(0, 6));
  return out;
}