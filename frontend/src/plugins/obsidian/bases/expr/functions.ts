/**
 * Bases 函数库 —— 按官方 Functions 文档实现（obsidian.md/help/bases/functions）。
 *
 * 分三类：
 * - 全局函数：`if()` `today()` `list()` …
 * - 类型方法：`"a".contains("b")` `file.hasTag("x")` `[1,2].map(…)`
 * - 列表聚合：给汇总公式用（`values.mean().round(3)`）
 *
 * 有三类实参要延迟求值：`list.filter/map/reduce` 的表达式、`file.*` 的宿主查询、
 * 汇总公式的 `values.*`。前者靠 `ctx.evalNode` 拿 AST 逐项跑，后者靠 FileApi。
 */

import { formatMoment } from "../../request";
import { addDuration, durationToMs, parseDuration, type Duration, type FileApi } from "./file-api";
import type { Node } from "./parser";
import {
  boolValue,
  BooleanValue,
  DateValue,
  DurationValue,
  FALSE,
  FileValue,
  HtmlValue,
  IconValue,
  ImageValue,
  LinkValue,
  ListValue,
  NULL,
  NumberValue,
  ObjectValue,
  RegexpValue,
  StringValue,
  TRUE,
  Value,
} from "./values";

/** 公式求值的宿主上下文 */
export interface EvalScope {
  /** 当前行的文件 */
  file: FileValue;
  /** note 属性（frontmatter） */
  noteProp(name: string): Value;
  /** 其它公式的结果 */
  formula(name: string): Value | null;
  /** `this`：主区打开时是 .base 文件本身；嵌入时是宿主笔记；侧栏时是当前活动文件 */
  self(): FileValue;
  fileApi: FileApi;
  /** 汇总公式里 `values` 绑定的列表 */
  values?: Value;
}

export interface FnCtx {
  scope: EvalScope;
  /** 按当前作用域求值一个 AST 节点 */
  evalNode: (n: Node, extraBindings?: Record<string, Value>) => Value;
  /**
   * 取第 i 个**未求值**的实参 AST。
   * filter/map/reduce 与汇总公式靠它拿到表达式（而不是被求值后的值）。
   */
  expressionArg: (i: number) => Node | null;
}

export type BasesFn = (args: Value[], ctx: FnCtx) => Value;

function need(args: Value[], n: number, name: string): void {
  if (args.length < n) throw new Error(`${name}() 需要 ${n} 个参数，收到 ${args.length} 个`);
}

function arg(args: Value[], i: number): Value {
  return args[i] ?? NULL;
}

function num(v: Value): number {
  if (v instanceof NumberValue) return v.value;
  if (v instanceof BooleanValue) return v.value ? 1 : 0;
  if (v instanceof DateValue) return v.value.getTime();
  const n = Number(v.toString().trim());
  return Number.isNaN(n) ? Number.NaN : n;
}

function asList(v: Value): Value[] {
  return v instanceof ListValue ? v.items : [v];
}

// ── 全局函数 ──────────────────────────────────────────────────────────

export const GLOBAL_FUNCTIONS: Record<string, BasesFn> = {
  if: (args) => {
    need(args, 2, "if");
    return args[0].isTruthy() ? args[1] : (args[2] ?? NULL);
  },

  today: () => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return new DateValue(d);
  },

  now: () => new DateValue(new Date()),

  date: (args) => {
    need(args, 1, "date");
    const v = args[0];
    if (v instanceof DateValue) return v;
    if (v instanceof NumberValue) return new DateValue(new Date(v.value));
    const raw = v.toString();
    const t = Date.parse(raw);
    if (!Number.isNaN(t)) return new DateValue(new Date(t));
    // 官方格式是 "YYYY-MM-DD HH:mm:ss"，JS 只认带 T 的；补 T 再试一次
    const t2 = Date.parse(raw.replace(" ", "T"));
    return new DateValue(Number.isNaN(t2) ? new Date(NaN) : new Date(t2));
  },

  duration: (args) => {
    need(args, 1, "duration");
    const dur = parseDuration(args[0].toString());
    if (!dur) return NULL;
    return new DurationValue(dur, durationToMs(dur));
  },

  list: (args) => {
    need(args, 1, "list");
    const v = args[0];
    return v instanceof ListValue ? v : new ListValue([v]);
  },

  number: (args) => {
    need(args, 1, "number");
    const v = args[0];
    if (v instanceof NumberValue) return v;
    if (v instanceof DateValue) return new NumberValue(v.value.getTime());
    if (v instanceof BooleanValue) return new NumberValue(v.value ? 1 : 0);
    if (v.isEmpty()) return NULL;
    const n = Number(v.toString().trim());
    // 官方语义：非数字字符串报错。给 0 会让筛选结果莫名其妙地少一半
    if (Number.isNaN(n)) throw new Error(`number() 无法转换 “${v.toString()}”`);
    return new NumberValue(n);
  },

  max: (args) => {
    if (args.length === 0) throw new Error("max() 至少要 1 个参数");
    return new NumberValue(Math.max(...args.map(num)));
  },

  min: (args) => {
    if (args.length === 0) throw new Error("min() 至少要 1 个参数");
    return new NumberValue(Math.min(...args.map(num)));
  },

  random: () => new NumberValue(Math.random()),

  link: (args) => {
    need(args, 1, "link");
    return new LinkValue(args[0].toString(), args[1]?.toString());
  },

  image: (args) => {
    need(args, 1, "image");
    return new ImageValue(args[0].toString());
  },

  icon: (args) => {
    need(args, 1, "icon");
    return new IconValue(args[0].toString());
  },

  html: (args) => {
    need(args, 1, "html");
    return new HtmlValue(args[0].toString());
  },

  escapeHTML: (args) => {
    need(args, 1, "escapeHTML");
    return new StringValue(
      args[0]
        .toString()
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;"),
    );
  },

  file: (args, ctx) => {
    need(args, 1, "file");
    const v = args[0];
    const raw = v instanceof FileValue ? v.filePath : v.toString();
    const resolved = ctx.scope.fileApi.resolve(raw);
    // 签名接受 file | string | url；url 解析不到本地文件就按原文记
    return new FileValue(resolved ?? raw);
  },
};

// ── 列表聚合（汇总公式用）─────────────────────────────────────────────

function numbersOf(items: Value[]): number[] {
  const out: number[] = [];
  for (const i of items) {
    if (i.isEmpty()) continue;
    const p = i.primitive();
    if (typeof p === "number") out.push(p);
    else if (typeof p === "boolean") out.push(p ? 1 : 0);
    else if (p instanceof Date) out.push(p.getTime());
  }
  return out;
}

/** 官方 Functions 页没列 mean/sum/median，但汇总文档明确用了 `values.mean()` */
const AGGREGATE_NAMES = ["mean", "min", "max", "sum", "median", "stddev"] as const;

function aggregate(name: (typeof AGGREGATE_NAMES)[number], items: Value[]): Value {
  const ns = numbersOf(items);
  switch (name) {
    case "mean":
      return ns.length ? new NumberValue(ns.reduce((a, b) => a + b, 0) / ns.length) : NULL;
    case "min":
      return ns.length ? new NumberValue(Math.min(...ns)) : NULL;
    case "max":
      return ns.length ? new NumberValue(Math.max(...ns)) : NULL;
    case "sum":
      return new NumberValue(ns.reduce((a, b) => a + b, 0));
    case "median": {
      if (ns.length === 0) return NULL;
      const s = [...ns].sort((a, b) => a - b);
      const mid = Math.floor(s.length / 2);
      return new NumberValue(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
    }
    default: {
      if (ns.length < 2) return new NumberValue(0);
      const mean = ns.reduce((a, b) => a + b, 0) / ns.length;
      return new NumberValue(Math.sqrt(ns.reduce((a, b) => a + (b - mean) ** 2, 0) / ns.length));
    }
  }
}

// ── 类型方法表 ────────────────────────────────────────────────────────

function stringMethods(): Record<string, BasesFn> {
  const s = (args: Value[], i: number): string => arg(args, i).toString();
  return {
    contains: (args) => boolValue(s(args, 0).includes(s(args, 1))),
    containsAll: (args) => boolValue(args.slice(1).every((v) => s(args, 0).includes(v.toString()))),
    containsAny: (args) => boolValue(args.slice(1).some((v) => s(args, 0).includes(v.toString()))),
    startsWith: (args) => boolValue(s(args, 0).startsWith(s(args, 1))),
    endsWith: (args) => boolValue(s(args, 0).endsWith(s(args, 1))),
    isEmpty: (args) => boolValue(s(args, 0).length === 0),
    lower: (args) => new StringValue(s(args, 0).toLowerCase()),
    title: (args) => new StringValue(s(args, 0).replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase())),
    trim: (args) => new StringValue(s(args, 0).trim()),
    repeat: (args) => new StringValue(s(args, 0).repeat(Math.max(0, Math.floor(num(arg(args, 1)))))),
    reverse: (args) => new StringValue([...s(args, 0)].reverse().join("")),
    slice: (args) =>
      new StringValue(s(args, 0).slice(num(arg(args, 1)), args.length > 2 ? num(arg(args, 2)) : undefined)),
    split: (args) => {
      const sep = arg(args, 1);
      const n = args.length > 2 ? num(arg(args, 2)) : undefined;
      const parts = sep instanceof RegexpValue ? s(args, 0).split(sep.re) : s(args, 0).split(sep.toString());
      return new ListValue((n === undefined ? parts : parts.slice(0, Math.max(0, Math.floor(n)))).map((p) => new StringValue(p)));
    },
    replace: (args) => {
      const pat = arg(args, 1);
      const rep = arg(args, 2).toString();
      // 官方：pattern 是 Regexp 时替换串里可用 $1 / $2 引用捕获组
      if (pat instanceof RegexpValue) return new StringValue(s(args, 0).replace(pat.re, rep));
      return new StringValue(s(args, 0).split(pat.toString()).join(rep));
    },
    length: (args) => new NumberValue(s(args, 0).length),
  };
}

function numberMethods(): Record<string, BasesFn> {
  const n0 = (args: Value[]): number => num(args[0]);
  return {
    abs: (args) => new NumberValue(Math.abs(n0(args))),
    ceil: (args) => new NumberValue(Math.ceil(n0(args))),
    floor: (args) => new NumberValue(Math.floor(n0(args))),
    round: (args) => {
      const digits = args.length > 1 ? num(arg(args, 1)) : 0;
      const f = 10 ** digits;
      // half-away-from-zero：官方示例 (2.5).round() → 3。JS 的 Math.round 对负数
      // 是 half-up（-2.5 → -2），跟直觉/官方不一致，所以自己算
      return new NumberValue((Math.sign(n0(args)) * Math.round(Math.abs(n0(args)) * f)) / f);
    },
    toFixed: (args) => new StringValue(n0(args).toFixed(num(arg(args, 1)))),
    isEmpty: (args) => boolValue(args[0].isEmpty()),
  };
}

function dateMethods(): Record<string, BasesFn> {
  const d = (args: Value[]): Date => (args[0] instanceof DateValue ? args[0].value : new Date(Number.NaN));
  return {
    year: (args) => new NumberValue(d(args).getFullYear()),
    month: (args) => new NumberValue(d(args).getMonth() + 1),
    day: (args) => new NumberValue(d(args).getDate()),
    hour: (args) => new NumberValue(d(args).getHours()),
    minute: (args) => new NumberValue(d(args).getMinutes()),
    second: (args) => new NumberValue(d(args).getSeconds()),
    millisecond: (args) => new NumberValue(d(args).getMilliseconds()),
    date: (args) => {
      const x = d(args);
      return new DateValue(new Date(x.getFullYear(), x.getMonth(), x.getDate()));
    },
    time: (args) => {
      const x = d(args);
      const p = (v: number): string => String(v).padStart(2, "0");
      return new StringValue(`${p(x.getHours())}:${p(x.getMinutes())}:${p(x.getSeconds())}`);
    },
    format: (args) => new StringValue(formatMoment(d(args), arg(args, 1).toString())),
    relative: (args) => new StringValue(relativeTime(d(args))),
    isEmpty: (args) => boolValue(Number.isNaN(d(args).getTime())),
  };
}

function relativeTime(target: Date): string {
  const diff = Date.now() - target.getTime();
  const abs = Math.abs(diff);
  if (abs < 60000) return "刚刚";
  const units: Array<[number, string]> = [
    [86400000 * 365, "年"],
    [86400000 * 30, "个月"],
    [86400000, "天"],
    [3600000, "小时"],
    [60000, "分钟"],
  ];
  for (const [ms, label] of units) {
    if (abs >= ms) {
      const n = Math.floor(abs / ms);
      return diff >= 0 ? `${n}${label}前` : `${n}${label}后`;
    }
  }
  return "刚刚";
}

function listMethods(): Record<string, BasesFn> {
  const items = (args: Value[]): Value[] => asList(args[0]);
  const out: Record<string, BasesFn> = {
    contains: (args) => boolValue(items(args).some((i) => i.looseEquals(arg(args, 1)))),
    containsAll: (args) => boolValue(args.slice(1).every((v) => items(args).some((i) => i.looseEquals(v)))),
    containsAny: (args) => boolValue(args.slice(1).some((v) => items(args).some((i) => i.looseEquals(v)))),
    isEmpty: (args) => boolValue(items(args).length === 0),
    join: (args) =>
      new StringValue(items(args).map((i) => i.toString()).join(args.length > 1 ? arg(args, 1).toString() : ",")),
    flat: (args) => new ListValue(items(args).flatMap((i) => (i instanceof ListValue ? i.items : [i]))),
    unique: (args) => {
      const seen = new Set<string>();
      const kept: Value[] = [];
      for (const i of items(args)) {
        const k = i.toString();
        if (seen.has(k)) continue;
        seen.add(k);
        kept.push(i);
      }
      return new ListValue(kept);
    },
    reverse: (args) => new ListValue([...items(args)].reverse()),
    sort: (args) => {
      const sorted = [...items(args)].sort(compareValues);
      return new ListValue(sorted);
    },
    slice: (args) => new ListValue(items(args).slice(num(arg(args, 1)), args.length > 2 ? num(arg(args, 2)) : undefined)),
    length: (args) => new NumberValue(items(args).length),
    // ↓ 延迟求值：实参是 AST 而非值
    filter: (args, ctx) => {
      const expr = ctx.expressionArg(1);
      if (!expr) throw new Error("filter() 需要一个表达式");
      const kept = items(args).filter((v, i) => ctx.evalNode(expr, { value: v, index: new NumberValue(i) }).isTruthy());
      return new ListValue(kept);
    },
    map: (args, ctx) => {
      const expr = ctx.expressionArg(1);
      if (!expr) throw new Error("map() 需要一个表达式");
      return new ListValue(items(args).map((v, i) => ctx.evalNode(expr, { value: v, index: new NumberValue(i) })));
    },
    reduce: (args, ctx) => {
      const expr = ctx.expressionArg(1);
      if (!expr) throw new Error("reduce() 需要一个表达式");
      let acc = args.length > 2 ? args[2] : NULL;
      items(args).forEach((v, i) => {
        acc = ctx.evalNode(expr, { value: v, index: new NumberValue(i), acc });
      });
      return acc;
    },
  };
  for (const name of AGGREGATE_NAMES) {
    out[name] = (args) => aggregate(name, items(args));
  }
  return out;
}

function objectMethods(): Record<string, BasesFn> {
  const fields = (args: Value[]): Map<string, Value> =>
    args[0] instanceof ObjectValue ? args[0].fields : new Map();
  return {
    isEmpty: (args) => boolValue(fields(args).size === 0),
    keys: (args) => new ListValue([...fields(args).keys()].map((k) => new StringValue(k))),
    values: (args) => new ListValue([...fields(args).values()]),
  };
}

function linkMethods(): Record<string, BasesFn> {
  return {
    asFile: (args) => new FileValue((args[0] as LinkValue).path),
    linksTo: (args, ctx) => {
      const l = args[0] as LinkValue;
      const other = arg(args, 1);
      const raw = other instanceof FileValue ? other.filePath : other.toString();
      const resolved = ctx.scope.fileApi.resolve(raw) ?? raw;
      return boolValue(ctx.scope.fileApi.links(l.path).some((x) => x.path === resolved));
    },
  };
}

function fileMethods(): Record<string, BasesFn> {
  const me = (args: Value[]): string => (args[0] as FileValue).filePath;
  return {
    asLink: (args) => new LinkValue(me(args), args.length > 1 ? args[1].toString() : undefined),
    hasTag: (args, ctx) => {
      const tags = ctx.scope.fileApi.tags(me(args));
      return boolValue(args.slice(1).some((v) => tags.includes(v.toString().replace(/^#/, ""))));
    },
    inFolder: (args, ctx) => {
      const target = arg(args, 1).toString().replace(/^\/+|\/+$/g, "");
      if (!target) return TRUE;
      const folder = ctx.scope.fileApi.folder(me(args));
      // 官方语义：在该文件夹**或其子文件夹**里
      return boolValue(folder === target || folder.startsWith(`${target}/`));
    },
    hasProperty: (args, ctx) => boolValue(ctx.scope.fileApi.hasProperty(me(args), arg(args, 1).toString())),
    hasLink: (args, ctx) => {
      const api = ctx.scope.fileApi;
      const other = arg(args, 1);
      const raw = other instanceof FileValue ? other.filePath : other.toString();
      const resolved = api.resolve(raw) ?? raw;
      return boolValue(api.links(me(args)).some((l) => l.path === resolved));
    },
  };
}

function regexpMethods(): Record<string, BasesFn> {
  return {
    matches: (args) => {
      const re = args[0] as RegexpValue;
      re.re.lastIndex = 0; // 带 g 标志时 lastIndex 会带偏，每次用前重置
      return boolValue(re.re.test(arg(args, 1).toString()));
    },
  };
}

const ANY_METHODS: Record<string, BasesFn> = {
  isTruthy: (args) => boolValue(args[0].isTruthy()),
  isType: (args) => boolValue(args[0].typeName() === arg(args, 1).toString()),
  toString: (args: Value[]) => new StringValue(args[0].toString()),
};

let methodCache: Map<string, Record<string, BasesFn>> | null = null;

/** 取某个值类型的方法表（任意类型的方法合并进去） */
export function methodsFor(v: Value): Record<string, BasesFn> {
  if (!methodCache) {
    methodCache = new Map<string, Record<string, BasesFn>>([
      ["string", stringMethods()],
      ["number", numberMethods()],
      ["date", dateMethods()],
      ["list", listMethods()],
      ["object", objectMethods()],
      ["link", linkMethods()],
      ["file", fileMethods()],
      ["regexp", regexpMethods()],
    ]);
  }
  const own = methodCache.get(v.typeName());
  return own ? { ...ANY_METHODS, ...own } : ANY_METHODS;
}

// ── 比较与算术 ────────────────────────────────────────────────────────

/** 值排序：空值最小，其次数字、日期、字符串、布尔 */
export function compareValues(a: Value, b: Value): number {
  const rank = (v: Value): number => {
    switch (v.typeName()) {
      case "null":
        return 0;
      case "number":
        return 1;
      case "date":
        return 2;
      case "string":
        return 3;
      case "boolean":
        return 4;
      default:
        return 5;
    }
  };
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return 0;
  const x = a.comparable();
  const y = b.comparable();
  if (typeof x === "number" && typeof y === "number") return x === y ? 0 : x < y ? -1 : 1;
  const sx = String(x);
  const sy = String(y);
  return sx === sy ? 0 : sx < sy ? -1 : 1;
}

/** 关系比较（> < >= <=）。缺值（null）最小。 */
export function relational(op: ">" | "<" | ">=" | "<=", a: Value, b: Value): Value {
  if (a.isEmpty() || b.isEmpty()) return FALSE;
  const c = compareValues(a, b);
  if (op === ">") return boolValue(c > 0);
  if (op === "<") return boolValue(c < 0);
  if (op === ">=") return boolValue(c >= 0);
  return boolValue(c <= 0);
}

/** `+` 是重载的：数字+数字、日期±时长、日期-日期得毫秒、字符串/列表拼接 */
export function binaryArith(op: "+" | "-" | "*" | "/" | "%", a: Value, b: Value): Value {
  if (a instanceof DateValue) {
    if (b instanceof DurationValue) return new DateValue(addDuration(a.value, op === "-" ? negateDur(b.dur) : b.dur));
    if (b instanceof StringValue) {
      const dur = parseDuration(b.value);
      if (dur) return new DateValue(addDuration(a.value, op === "-" ? negateDur(dur) : dur));
      throw new Error(`日期算术的右侧必须是时长字符串（得到 “${b.value}”）`);
    }
    if (b instanceof DateValue && op === "-") {
      // 官方：两日期相减得毫秒差
      return new NumberValue(a.value.getTime() - b.value.getTime());
    }
  }
  if (a instanceof DurationValue) {
    // 官方：标量必须在左边（duration('5h') * 2 合法，2 * duration('5h') 不合法）
    if (op === "*" && b instanceof NumberValue) {
      const dur = scaleDur(a.dur, b.value);
      return new DurationValue(dur, durationToMs(dur));
    }
    if (b instanceof DurationValue && (op === "+" || op === "-")) {
      const dur = op === "+" ? addDur(a.dur, b.dur) : addDur(a.dur, negateDur(b.dur));
      return new DurationValue(dur, durationToMs(dur));
    }
    if (op === "/" && b instanceof NumberValue && b.value !== 0) {
      const dur = scaleDur(a.dur, 1 / b.value);
      return new DurationValue(dur, durationToMs(dur));
    }
  }
  // 官方明确：duration 与标量运算时标量必须在左边（duration('5h') * 2 合法，
  // 2 * duration('5h') 不合法）。默默算出一个数只会让人以为写对了。
  if (b instanceof DurationValue && (op === "*" || op === "/")) {
    throw new Error(`时长必须在运算符左边：写成 duration('…') ${op} 数字，而不是 数字 ${op} duration('…')`);
  }
  if (a instanceof StringValue || b instanceof StringValue) {
    if (op !== "+") throw new Error(`“${op}” 不能用于字符串`);
    return new StringValue(a.toString() + b.toString());
  }
  if (a instanceof ListValue && op === "+") {
    return new ListValue([...a.items, ...(b instanceof ListValue ? b.items : [b])]);
  }
  const x = num(a);
  const y = num(b);
  if (Number.isNaN(x) || Number.isNaN(y)) {
    if (op === "+") return new StringValue(a.toString() + b.toString());
    throw new Error(`“${op}” 的操作数不是数字（${a.toString()} / ${b.toString()}）`);
  }
  switch (op) {
    case "+":
      return new NumberValue(x + y);
    case "-":
      return new NumberValue(x - y);
    case "*":
      return new NumberValue(x * y);
    case "/":
      if (y === 0) throw new Error("除以 0");
      return new NumberValue(x / y);
    default:
      if (y === 0) throw new Error("模 0");
      return new NumberValue(x % y);
  }
}

function negateDur(d: Duration): Duration {
  return { year: -d.year, month: -d.month, week: -d.week, day: -d.day, hour: -d.hour, minute: -d.minute, second: -d.second };
}

function addDur(a: Duration, b: Duration): Duration {
  return {
    year: a.year + b.year,
    month: a.month + b.month,
    week: a.week + b.week,
    day: a.day + b.day,
    hour: a.hour + b.hour,
    minute: a.minute + b.minute,
    second: a.second + b.second,
  };
}

function scaleDur(d: Duration, k: number): Duration {
  return {
    year: d.year * k,
    month: d.month * k,
    week: d.week * k,
    day: d.day * k,
    hour: d.hour * k,
    minute: d.minute * k,
    second: d.second * k,
  };
}