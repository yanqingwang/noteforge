/**
 * 网络请求与常用工具模块：requestUrl / request / moment / FileSystemAdapter。
 *
 * requestUrl 是 Obsidian 的「绕过 CORS」请求 API：插件调用外部 LLM API 全靠它。
 * 宿主 webview 里直接用 fetch，受 CSP 的 connect-src 约束（noteforge 已放开 https:）。
 */

export interface RequestUrlParam {
  url: string;
  method?: string;
  contentType?: string;
  body?: string | ArrayBuffer;
  headers?: Record<string, string>;
  throw?: boolean;
}

export interface RequestUrlResponse {
  status: number;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
  json: unknown;
  text: string;
}

function headersToObject(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

export async function requestUrl(param: string | RequestUrlParam): Promise<RequestUrlResponse> {
  const p: RequestUrlParam = typeof param === "string" ? { url: param } : param;
  const init: RequestInit = {
    method: p.method ?? "GET",
    headers: { ...(p.headers ?? {}), ...(p.contentType ? { "Content-Type": p.contentType } : {}) },
  };
  if (p.body !== undefined && p.body !== null) {
    init.body = typeof p.body === "string" ? p.body : new Uint8Array(p.body);
  }
  const res = await fetch(p.url, init);
  const buf = await res.arrayBuffer();
  const text = new TextDecoder().decode(buf);
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (p.throw !== false && !res.ok) {
    const err = new Error(`请求失败 ${res.status} ${res.statusText}: ${text.slice(0, 200)}`) as Error & {
      status: number;
      text: string;
    };
    err.status = res.status;
    err.text = text;
    throw err;
  }
  return { status: res.status, headers: headersToObject(res.headers), arrayBuffer: buf, json, text };
}

/** Obsidian 的旧名，实际是 requestUrl 的别名。 */
export const request = requestUrl;

/* ---------- FileSystemAdapter ---------- */

export class FileSystemAdapter {
  basePath: string;
  constructor(basePath = "/") {
    this.basePath = basePath;
  }
  getName(): string {
    return "noteforge-fs";
  }
  getBasePath(): string {
    return this.basePath;
  }
  async exists(): Promise<boolean> {
    return false;
  }
}

/* ---------- moment 的最小实现 ----------
 * 插件普遍用 moment 做时间格式化。完整 moment 很大，这里只实现被高频调用的
 * 子集（format/toISOString/unix/add/subtract/diff/isBefore/isAfter/startOf/endOf/calendar/fromNow）。
 */

type MomentLike = {
  format(template?: string): string;
  toISOString(): string;
  unix(): number;
  valueOf(): number;
  add(n: number, unit?: string): MomentLike;
  subtract(n: number, unit?: string): MomentLike;
  diff(other: DateLike, unit?: string): number;
  isBefore(other: DateLike): boolean;
  isAfter(other: DateLike): boolean;
  isSame(other: DateLike, unit?: string): boolean;
  isSameOrAfter(other: DateLike, unit?: string): boolean;
  isSameOrBefore(other: DateLike, unit?: string): boolean;
  isBetween(a: DateLike, b: DateLike, unit?: string): boolean;
  startOf(unit: string): MomentLike;
  endOf(unit: string): MomentLike;
  fromNow(): string;
  calendar(): string;
  isValid(): boolean;
  clone(): MomentLike;
  year(): number;
  month(): number;
  date(): number;
  day(): number;
};

export type DateLike = Date | number | MomentLike | string;

const pad = (n: number, w = 2) => String(Math.abs(Math.trunc(n))).padStart(w, "0");

const UNIT_MS: Record<string, number> = {
  ms: 1,
  millisecond: 1,
  s: 1000,
  second: 1000,
  m: 60000,
  minute: 60000,
  h: 3600000,
  hour: 3600000,
  d: 86400000,
  day: 86400000,
  w: 604800000,
  week: 604800000,
  M: 2592000000,
  month: 2592000000,
  y: 31536000000,
  year: 31536000000,
};

function toDate(v: DateLike | undefined): Date {
  if (v === undefined) return new Date();
  if (v instanceof Date) return v;
  if (typeof v === "number") return new Date(v);
  if (typeof v === "string") return new Date(v);
  return new Date(v.valueOf());
}

function formatMoment(d: Date, template?: string): string {
  const tokens: Array<[RegExp, () => string]> = [
    [/YYYY/g, () => String(d.getFullYear())],
    [/YY/g, () => pad(d.getFullYear() % 100)],
    [/MMMM/g, () => ["一月", "二月", "三月", "四月", "五月", "六月", "七月", "八月", "九月", "十月", "十一月", "十二月"][d.getMonth()]],
    [/MMM/g, () => ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()]],
    [/MM/g, () => pad(d.getMonth() + 1)],
    [/DD/g, () => pad(d.getDate())],
    [/Do/g, () => String(d.getDate())],
    [/dddd/g, () => ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"][d.getDay()]],
    [/ddd/g, () => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()]],
    [/HH/g, () => pad(d.getHours())],
    [/hh/g, () => pad(d.getHours() % 12 || 12)],
    [/mm/g, () => pad(d.getMinutes())],
    [/ss/g, () => pad(d.getSeconds())],
    [/SSS/g, () => pad(d.getMilliseconds(), 3)],
    [/A/g, () => (d.getHours() < 12 ? "AM" : "PM")],
    [/a/g, () => (d.getHours() < 12 ? "am" : "pm")],
    [/ZZ/g, () => {
      const off = -d.getTimezoneOffset();
      return `${off < 0 ? "-" : "+"}${pad(off / 60)}${pad(off % 60)}`;
    }],
    [/Z/g, () => {
      const off = -d.getTimezoneOffset();
      return `${off < 0 ? "-" : "+"}${pad(off / 60)}${pad(off % 60)}`;
    }],
  ];
  let out = template ?? "YYYY-MM-DDTHH:mm:ssZ";
  for (const [re, fn] of tokens) out = out.replace(re, fn);
  return out;
}

function sameDate(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function mkMoment(v?: DateLike): MomentLike {
  const m: MomentLike = {
    format: (t?: string) => formatMoment(new Date(m.valueOf()), t),
    toISOString: () => new Date(m.valueOf()).toISOString(),
    unix: () => Math.floor(m.valueOf() / 1000),
    valueOf: () => toDate(v).valueOf(),
    add: (n, unit = "ms") => mkMoment(toDate(v).valueOf() + n * (UNIT_MS[unit] ?? 1)),
    subtract: (n, unit = "ms") => mkMoment(toDate(v).valueOf() - n * (UNIT_MS[unit] ?? 1)),
    diff: (other, unit = "ms") => Math.trunc((m.valueOf() - toDate(other).valueOf()) / (UNIT_MS[unit] ?? 1)),
    isBefore: (other) => m.valueOf() < toDate(other).valueOf(),
    isAfter: (other) => m.valueOf() > toDate(other).valueOf(),
    // unit 支持：calendar 这类插件会写 isSame(x, "day") / isSame(x, "month")
    isSame: (other, unit) => {
      if (!unit) return m.valueOf() === toDate(other).valueOf();
      const a = toDate(other);
      const b = new Date(m.valueOf());
      const u = unit.toLowerCase();
      if (u === "day") return sameDate(b, a);
      if (u === "month") return b.getFullYear() === a.getFullYear() && b.getMonth() === a.getMonth();
      if (u === "year") return b.getFullYear() === a.getFullYear();
      if (u === "hour") return sameDate(b, a) && b.getHours() === a.getHours();
      if (u === "minute") return sameDate(b, a) && b.getHours() === a.getHours() && b.getMinutes() === a.getMinutes();
      return m.valueOf() === a.valueOf();
    },
    isSameOrAfter: (other, unit) => m.valueOf() >= toDate(other).valueOf() || unit === undefined,
    isSameOrBefore: (other, unit) => m.valueOf() <= toDate(other).valueOf() || unit === undefined,
    isBetween: (a, b, unit) =>
      unit ? m.isSame(a, unit) || m.isSame(b, unit) || (m.isAfter(a) && m.isBefore(b))
           : m.isAfter(a) && m.isBefore(b),
    startOf: (unit) => {
      const d = new Date(toDate(v).valueOf());
      if (unit === "day") d.setHours(0, 0, 0, 0);
      else if (unit === "month") d.setDate(1), d.setHours(0, 0, 0, 0);
      else if (unit === "year") d.setMonth(0, 1), d.setHours(0, 0, 0, 0);
      else if (unit === "hour") d.setMinutes(0, 0, 0);
      return mkMoment(d);
    },
    endOf: (unit) => {
      const d = new Date(toDate(v).valueOf());
      if (unit === "day") d.setHours(23, 59, 59, 999);
      else if (unit === "month") d.setMonth(d.getMonth() + 1, 0), d.setHours(23, 59, 59, 999);
      else if (unit === "year") d.setMonth(11, 31), d.setHours(23, 59, 59, 999);
      else if (unit === "hour") d.setMinutes(59, 59, 999);
      return mkMoment(d);
    },
    fromNow: () => {
      const diff = Date.now() - m.valueOf();
      const abs = Math.abs(diff);
      const label = (n: number, u: string) => `${n} ${u}`;
      const s = abs < UNIT_MS.minute ? label(Math.round(abs / 1000), "秒") : abs < UNIT_MS.hour ? label(Math.round(abs / UNIT_MS.minute), "分钟") : abs < UNIT_MS.day ? label(Math.round(abs / UNIT_MS.hour), "小时") : label(Math.round(abs / UNIT_MS.day), "天");
      return diff >= 0 ? `${s}前` : `${s}后`;
    },
    calendar: () => formatMoment(new Date(toDate(v).valueOf()), "YYYY-MM-DD"),
    isValid: () => !Number.isNaN(toDate(v).getTime()),
    clone: () => mkMoment(toDate(v).valueOf()),
    year: () => new Date(m.valueOf()).getFullYear(),
    month: () => new Date(m.valueOf()).getMonth(),
    date: () => new Date(m.valueOf()).getDate(),
    day: () => new Date(m.valueOf()).getDay(),
  };
  return m;
}

/**
 * moment(x?)：不传时返回当前时间（Obsidian 同）。
 * 附带的 locale()/defineLocale() 是必需项——4/41 个样本插件在加载期就调用
 * `moment.locale("zh")`，缺了会直接抛。
 */
interface MomentFn {
  (v?: DateLike): MomentLike;
  locale(preset?: string): string;
  locales(): string[];
  defineLocale(name: string, config: unknown): string;
  localeData(key?: string): Record<string, unknown>;
  duration: (input?: unknown, unit?: string) => Record<string, number>;
  weekdays(): string[];
  weekdaysShort(): string[];
  months(): string[];
  monthsShort(): string[];
}

const momentFn: MomentFn = ((v?: DateLike) => mkMoment(v)) as MomentFn & {
  locale(preset?: string): string;
  locales(): string[];
  defineLocale(name: string, config: unknown): string;
  localeData(key?: string): Record<string, unknown>;
  duration: (input?: unknown, unit?: string) => Record<string, number>;
  weekdays(): string[];
  weekdaysShort(): string[];
  months(): string[];
  monthsShort(): string[];
};

const CURRENT_LOCALE = { name: "en" };

momentFn.locale = (preset?: string): string => {
  if (preset) CURRENT_LOCALE.name = preset;
  return CURRENT_LOCALE.name;
};
momentFn.locales = (): string[] => ["en", "zh", "zh-cn", "zh-tw", "ja", "de", "fr", "es", "ru", "ko"];
momentFn.defineLocale = (name: string, _config: unknown): string => {
  CURRENT_LOCALE.name = name;
  return name;
};
const WEEKDAYS = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
const WEEKDAYS_SHORT = ["日", "一", "二", "三", "四", "五", "六"];
const MONTHS = ["一月", "二月", "三月", "四月", "五月", "六月", "七月", "八月", "九月", "十月", "十一月", "十二月"];
const MONTHS_SHORT = ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"];

momentFn.localeData = (key?: string) => {
  // Obsidian 界面是中文，weekdays/months 给中文；插件主要取 dow()/months() 这类
  const data = () => ({
    name: key ?? CURRENT_LOCALE.name,
    weekdays: WEEKDAYS,
    weekdaysShort: WEEKDAYS_SHORT,
    weekdaysMin: WEEKDAYS_SHORT,
    months: MONTHS,
    monthsShort: MONTHS_SHORT,
    firstDayOfWeek: () => 1,
    dow: () => 1,
    doy: () => 6,
    firstDayOfYear: () => 1,
    longDateFormat: (fmt: string) => fmt,
  });
  // moment 的 localeData 既是对象又能当函数调用（历史包袱），用代理同时满足两种用法
  const fn = (): unknown => data();
  return new Proxy(fn, {
    get: (_t, prop) => {
      if (prop in fn) return (fn as unknown as Record<string, unknown>)[prop as string];
      return data()[prop as keyof ReturnType<typeof data>];
    },
    has: (_t, prop) => prop in fn || prop in data(),
  }) as unknown as Record<string, unknown>;
};
momentFn.weekdays = (): string[] => WEEKDAYS;
momentFn.weekdaysShort = (): string[] => WEEKDAYS_SHORT;
momentFn.months = (): string[] => MONTHS;
momentFn.monthsShort = (): string[] => MONTHS_SHORT;
momentFn.duration = (): Record<string, number> => ({});

export const moment = momentFn;

export const duration = (): Record<string, number> => ({});
export const format = (t: number): string => pad(t);
export const isValid = (v: unknown): boolean => !Number.isNaN(Date.parse(String(v)));

/* ---------- 编辑器相关类型占位（插件多用作类型，少数用作 instanceof） ---------- */

export class EditorPosition {
  line: number;
  ch: number;
  constructor(line: number, ch: number) {
    this.line = line;
    this.ch = ch;
  }
}

export class EditorSelection {
  anchor: EditorPosition;
  head: EditorPosition;
  constructor(anchor: EditorPosition, head: EditorPosition) {
    this.anchor = anchor;
    this.head = head;
  }
}

export class EditorChange {
  text: string;
  from: EditorPosition;
  to: EditorPosition;
  constructor(text: string, from: EditorPosition, to: EditorPosition) {
    this.text = text;
    this.from = from;
    this.to = to;
  }
}

export class EditorRange {
  from: EditorPosition;
  to: EditorPosition;
  constructor(from: EditorPosition, to: EditorPosition) {
    this.from = from;
    this.to = to;
  }
}