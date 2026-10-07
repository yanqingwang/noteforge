/**
 * Bases 值类型。
 *
 * 对齐 Obsidian 的 `Value`（公开声明只有 `toString()` / `isTruthy()` / `equals()`
 * / `looseEquals()` / `renderTo()` 与静态 `type` / `equals` / `looseEquals`）。
 *
 * 设计要点：类型化方法派发靠「每种类型一张方法表」（见 functions.ts），
 * 而不是给每个类写一堆方法 —— Obsidian 的方法有 80 多个，散在类里没法维护，
 * 而且 `.filter(value > 2)` 这类写法要求方法能拿到未求值的表达式 AST。
 */

import type { Duration } from "./file-api";

export type BasesValueType =
  | "null"
  | "boolean"
  | "number"
  | "string"
  | "date"
  | "list"
  | "object"
  | "link"
  | "file"
  | "image"
  | "html"
  | "icon"
  | "duration"
  | "regexp";

/**
 * `Value.renderTo(el, ctx)` 的上下文。Obsidian 的 RenderContext 是内部 API
 * （公开声明里是空类），这里只留 Bases 视图真正用得上的东西。
 */
export interface ValueRenderContext {
  /** 宿主给的打开文件能力（渲染链接时点进去） */
  openFile?: (path: string, newLeaf?: boolean) => void;
  /** 当前渲染所在文件的路径（相对链接解析用） */
  sourcePath?: string;
}

export abstract class Value {
  /** 类型名（`isType()` 用）。Obsidian 里是静态字段，子类覆盖。 */
  static type: BasesValueType = "null";

  abstract toString(): string;
  abstract isTruthy(): boolean;

  /** 严格相等：同类型同值 */
  equals(other: Value): boolean {
    return this === other || (this.constructor === other.constructor && this.strictEquals(other));
  }

  /** 宽松相等：不同类型也能比（`1 == "1"` 为真） */
  looseEquals(other: Value): boolean {
    return this.equals(other);
  }

  protected strictEquals(other: Value): boolean {
    return this.toString() === other.toString();
  }

  static equals(a: Value | null, b: Value | null): boolean {
    if (a === null || b === null) return a === b;
    return a.equals(b);
  }

  static looseEquals(a: Value | null, b: Value | null): boolean {
    if (a === null || b === null) return a === b;
    return a.looseEquals(b);
  }

  /** 默认渲染：往 el 里放一个文本节点。子类覆盖（链接/图片/HTML 各自不同）。 */
  renderTo(el: HTMLElement, _ctx: ValueRenderContext): void {
    const text = this.toString();
    if (text) el.appendChild(el.ownerDocument.createTextNode(text));
  }

  /**
   * 类型名的实例访问器。Obsidian 把 `type` 做成**静态**字段，公式里的
   * `isType("string")` 与按类型分派都需要拿实例的类型，所以另给一个实例方法。
   */
  typeName(): BasesValueType {
    return (this.constructor as typeof Value).type;
  }

  /** 值是否为空（`Empty` / `Filled` 汇总与 `x.isEmpty()` 都用） */
  isEmpty(): boolean {
    return false;
  }

  /** 内部比较用的原始值（排序、聚合都走它） */
  primitive(): unknown {
    return this.toString();
  }

  /** 排序用的可比值 */
  comparable(): unknown {
    return this.primitive();
  }
}

export class NullValue extends Value {
  static override type: BasesValueType = "null";
  override toString(): string {
    return "";
  }
  override isTruthy(): boolean {
    return false;
  }
  override isEmpty(): boolean {
    return true;
  }
  override primitive(): unknown {
    return null;
  }
  override renderTo(): void {
    /* 空值不渲染任何东西 */
  }
}

export class BooleanValue extends Value {
  static override type: BasesValueType = "boolean";
  readonly value: boolean;
  constructor(value: boolean) {
    super();
  this.value = value;
  }
  override toString(): string {
    return this.value ? "true" : "false";
  }
  override isTruthy(): boolean {
    return this.value;
  }
  protected override strictEquals(other: Value): boolean {
    return other instanceof BooleanValue && other.value === this.value;
  }
  override primitive(): unknown {
    return this.value;
  }
  override comparable(): unknown {
    return this.value ? 1 : 0;
  }
  override renderTo(el: HTMLElement): void {
    const box = el.ownerDocument.createElement("input");
    box.type = "checkbox";
    box.checked = this.value;
    box.disabled = true;
    box.style.verticalAlign = "middle";
    el.appendChild(box);
  }
}

export class NumberValue extends Value {
  static override type: BasesValueType = "number";
  readonly value: number;
  constructor(value: number) {
    super();
  this.value = value;
  }
  override toString(): string {
    return String(this.value);
  }
  override isTruthy(): boolean {
    return this.value !== 0 && !Number.isNaN(this.value);
  }
  protected override strictEquals(other: Value): boolean {
    return other instanceof NumberValue && other.value === this.value;
  }
  override looseEquals(other: Value): boolean {
    // 数字与字符串/布尔可松散比较（Obsidian 的 == 语义）
    if (other instanceof NumberValue) return other.value === this.value;
    if (other instanceof StringValue) {
      const n = Number(other.value);
      return !Number.isNaN(n) && n === this.value;
    }
    if (other instanceof BooleanValue) return (other.value ? 1 : 0) === this.value;
    if (other instanceof DateValue) return other.value.getTime() === this.value;
    return false;
  }
  override primitive(): unknown {
    return this.value;
  }
  override comparable(): unknown {
    return this.value;
  }
}

export class StringValue extends Value {
  static override type: BasesValueType = "string";
  readonly value: string;
  constructor(value: string) {
    super();
  this.value = value;
  }
  override toString(): string {
    return this.value;
  }
  override isTruthy(): boolean {
    return this.value.length > 0;
  }
  override isEmpty(): boolean {
    return this.value.length === 0;
  }
  protected override strictEquals(other: Value): boolean {
    return other instanceof StringValue && other.value === this.value;
  }
  override looseEquals(other: Value): boolean {
    if (other instanceof StringValue) return other.value === this.value;
    if (other instanceof NumberValue) return String(other.value) === this.value;
    if (other instanceof BooleanValue) return String(other.value) === this.value;
    return other.toString() === this.value;
  }
  override primitive(): unknown {
    return this.value;
  }
  override comparable(): unknown {
    return this.value;
  }
}

export class DateValue extends Value {
  static override type: BasesValueType = "date";
  readonly value: Date;
  constructor(value: Date) {
    super();
  this.value = value;
  }
  override toString(): string {
    return this.value.toISOString();
  }
  override isTruthy(): boolean {
    return !Number.isNaN(this.value.getTime());
  }
  override isEmpty(): boolean {
    return Number.isNaN(this.value.getTime());
  }
  protected override strictEquals(other: Value): boolean {
    return other instanceof DateValue && other.value.getTime() === this.value.getTime();
  }
  override looseEquals(other: Value): boolean {
    if (other instanceof DateValue) return other.value.getTime() === this.value.getTime();
    if (other instanceof NumberValue) return other.value === this.value.getTime();
    if (other instanceof StringValue) {
      const t = Date.parse(other.value);
      return !Number.isNaN(t) && t === this.value.getTime();
    }
    return false;
  }
  override primitive(): unknown {
    return this.value;
  }
  override comparable(): unknown {
    return this.value.getTime();
  }
  override renderTo(el: HTMLElement, ctx: ValueRenderContext): void {
    const s = el.ownerDocument.createElement("span");
    s.textContent = formatDate(this.value);
    if (ctx.sourcePath) {
      s.style.cursor = "default";
    }
    el.appendChild(s);
  }
}

/** 列表元素在比较时的排序权重：空 < 数字 < 字符串 < 日期 < 布尔 */
export class ListValue extends Value {
  static override type: BasesValueType = "list";
  readonly items: Value[];
  constructor(items: Value[]) {
    super();
  this.items = items;
  }
  override toString(): string {
    return this.items.map((i) => i.toString()).join(", ");
  }
  override isTruthy(): boolean {
    return this.items.length > 0;
  }
  override isEmpty(): boolean {
    return this.items.length === 0;
  }
  protected override strictEquals(other: Value): boolean {
    return (
      other instanceof ListValue &&
      other.items.length === this.items.length &&
      other.items.every((v, i) => this.items[i].equals(v))
    );
  }
  override primitive(): unknown {
    return this.items.map((i) => i.primitive());
  }
  override comparable(): unknown {
    return this.items.length;
  }
  override renderTo(el: HTMLElement, ctx: ValueRenderContext): void {
    this.items.forEach((item, i) => {
      if (i > 0) el.appendChild(el.ownerDocument.createTextNode(", "));
      item.renderTo(el, ctx);
    });
  }
}

export class ObjectValue extends Value {
  static override type: BasesValueType = "object";
  readonly fields: Map<string, Value>;
  constructor(fields: Map<string, Value>) {
    super();
    this.fields = fields;
  }
  override toString(): string {
    const parts: string[] = [];
    for (const [k, v] of this.fields) parts.push(`${k}: ${v.toString()}`);
    return `{ ${parts.join(", ")} }`;
  }
  override isTruthy(): boolean {
    return this.fields.size > 0;
  }
  override isEmpty(): boolean {
    return this.fields.size === 0;
  }
  protected override strictEquals(other: Value): boolean {
    if (!(other instanceof ObjectValue) || other.fields.size !== this.fields.size) return false;
    for (const [k, v] of this.fields) {
      const o = other.fields.get(k);
      if (!o || !v.equals(o)) return false;
    }
    return true;
  }
  override primitive(): unknown {
    const out: Record<string, unknown> = {};
    for (const [k, v] of this.fields) out[k] = v.primitive();
    return out;
  }
  /** 取字段（`property.subprop` / `property["subprop"]`） */
  get(key: string): Value | null {
    return this.fields.get(key) ?? null;
  }

  /** 从 JS 普通对象构造（file.properties 走这条） */
  static from(obj: Record<string, unknown>): ObjectValue {
    const m = new Map<string, Value>();
    for (const [k, v] of Object.entries(obj)) m.set(k, fromJs(v));
    return new ObjectValue(m);
  }
  override renderTo(el: HTMLElement, ctx: ValueRenderContext): void {
    for (const [k, v] of this.fields) {
      const kEl = el.ownerDocument.createElement("span");
      kEl.textContent = `${k}: `;
      const vEl = el.ownerDocument.createElement("span");
      v.renderTo(vEl, ctx);
      el.append(kEl, vEl, el.ownerDocument.createTextNode(" "));
    }
  }
}

/** 双链。`path` 为解析后的 vault 内路径；解析不到时保留原文。 */
export class LinkValue extends Value {
  static override type: BasesValueType = "link";
  readonly path: string;
  readonly display?: string;
  constructor(path: string, display?: string) {
    super();
    this.path = path;
    this.display = display;
  }
  override toString(): string {
    return this.display ?? this.path;
  }
  override isTruthy(): boolean {
    return true;
  }
  protected override strictEquals(other: Value): boolean {
    // 官方语义：指向同一文件即相等；文件不存在时要求链接原文一致
    if (!(other instanceof LinkValue)) return false;
    if (this.path && other.path) return this.path === other.path;
    return this.path === other.path;
  }
  override looseEquals(other: Value): boolean {
    if (other instanceof LinkValue) return this.strictEquals(other);
    if (other instanceof FileValue) return other.filePath === this.path;
    return this.toString() === other.toString();
  }
  override primitive(): unknown {
    return this.path;
  }
  override comparable(): unknown {
    return this.toString();
  }
  override renderTo(el: HTMLElement, ctx: ValueRenderContext): void {
    const a = el.ownerDocument.createElement("a");
    a.href = "#";
    a.textContent = this.toString();
    a.className = "internal-link";
    if (ctx.openFile && this.path) {
      a.addEventListener("click", (evt) => {
        evt.preventDefault();
        ctx.openFile?.(this.path);
      });
    }
    el.appendChild(a);
  }
}

/** vault 里的一个文件。`file.*` 属性与 `file.hasTag()` 等方法的宿主。 */
export class FileValue extends Value {
  static override type: BasesValueType = "file";
  readonly filePath: string;
  constructor(filePath: string) {
    super();
  this.filePath = filePath;
  }
  override toString(): string {
    return this.filePath;
  }
  override isTruthy(): boolean {
    return true;
  }
  protected override strictEquals(other: Value): boolean {
    return other instanceof FileValue && other.filePath === this.filePath;
  }
  override looseEquals(other: Value): boolean {
    if (other instanceof FileValue) return other.filePath === this.filePath;
    if (other instanceof LinkValue) return other.path === this.filePath;
    return this.filePath === other.toString();
  }
  override primitive(): unknown {
    return this.filePath;
  }
  override comparable(): unknown {
    return this.filePath;
  }
  override renderTo(el: HTMLElement, ctx: ValueRenderContext): void {
    new LinkValue(this.filePath).renderTo(el, ctx);
  }
}

export class ImageValue extends Value {
  static override type: BasesValueType = "image";
  readonly source: string;
  constructor(source: string) {
    super();
  this.source = source;
  }
  override toString(): string {
    return this.source;
  }
  override isTruthy(): boolean {
    return this.source.length > 0;
  }
  override renderTo(el: HTMLElement): void {
    const img = el.ownerDocument.createElement("img");
    img.src = this.source;
    img.alt = "";
    img.style.maxWidth = "100%";
    el.appendChild(img);
  }
}

export class HtmlValue extends Value {
  static override type: BasesValueType = "html";
  readonly html: string;
  constructor(html: string) {
    super();
  this.html = html;
  }
  override toString(): string {
    return this.html;
  }
  override isTruthy(): boolean {
    return this.html.length > 0;
  }
  override renderTo(el: HTMLElement): void {
    // Bases 的 html() 语义就是「在视图里当 HTML 渲染」，不是转义后当文本显示。
    // 这是官方行为（见 Functions 页 html() 说明），故走 innerHTML。
    const span = el.ownerDocument.createElement("span");
    span.innerHTML = this.html;
    el.appendChild(span);
  }
}

export class IconValue extends Value {
  static override type: BasesValueType = "icon";
  readonly name: string;
  constructor(name: string) {
    super();
  this.name = name;
  }
  override toString(): string {
    return this.name;
  }
  override isTruthy(): boolean {
    return this.name.length > 0;
  }
  override renderTo(el: HTMLElement): void {
    const span = el.ownerDocument.createElement("span");
    span.className = `nf-bases-icon lucide-${this.name.replace(/^lucide-/, "")}`;
    span.textContent = "◻";
    el.appendChild(span);
  }
}

/**
 * 时长。官方语义：`duration('1d') * 2` 合法，但 `2 * duration('1d')` **不合法**
 * （标量必须在左边），因为 duration 是 Date 加法的右操作数专用形态。
 *
 * 存结构（年/月/日…）而不只是毫秒：`duration('1M')` 是「1 个月」，
 * 只留毫秒的话 `date + duration('1M')` 会退化成加 30 天。
 */
export class DurationValue extends Value {
  static override type: BasesValueType = "duration";
  readonly dur: Duration;
  readonly ms: number;
  constructor(dur: Duration, ms: number) {
    super();
    this.dur = dur;
    this.ms = ms;
  }
  override toString(): string {
    return String(this.ms);
  }
  override isTruthy(): boolean {
    return this.ms !== 0;
  }
  override primitive(): unknown {
    return this.ms;
  }
}

/** 正则字面量（`/abc/i`），给 `.matches()` 用。 */
export class RegexpValue extends Value {
  static override type: BasesValueType = "regexp";
  readonly source: string;
  readonly flags: string;
  readonly re: RegExp;
  constructor(source: string, flags: string, re: RegExp) {
    super();
    this.source = source;
    this.flags = flags;
    this.re = re;
  }
  override toString(): string {
    return `/${this.source}/${this.flags}`;
  }
  override isTruthy(): boolean {
    return true;
  }
  override primitive(): unknown {
    return this.re;
  }
}

export const NULL = new NullValue();
export const TRUE = new BooleanValue(true);
export const FALSE = new BooleanValue(false);

export function boolValue(b: boolean): BooleanValue {
  return b ? TRUE : FALSE;
}

/** 把 JS 原生值（YAML 解析出来的）包成 Bases 值 */
export function fromJs(v: unknown): Value {
  if (v === null || v === undefined) return NULL;
  if (v instanceof Value) return v;
  if (v instanceof Date) return new DateValue(v);
  if (typeof v === "boolean") return boolValue(v);
  if (typeof v === "number") return new NumberValue(v);
  if (typeof v === "string") return new StringValue(v);
  if (Array.isArray(v)) return new ListValue(v.map(fromJs));
  if (typeof v === "object") {
    const m = new Map<string, Value>();
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) m.set(k, fromJs(val));
    return new ObjectValue(m);
  }
  return new StringValue(String(v));
}

/** 取值里的原始 JS 值（比较 / 排序 / 导出 CSV 用） */
export function toJs(v: Value): unknown {
  if (v instanceof NullValue) return null;
  if (v instanceof ListValue) return v.items.map(toJs);
  if (v instanceof ObjectValue) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of v.fields) out[k] = toJs(val);
    return out;
  }
  if (v instanceof DateValue) return v.value;
  if (v instanceof BooleanValue) return v.value;
  if (v instanceof NumberValue) return v.value;
  if (v instanceof StringValue) return v.value;
  return v.toString();
}

/** YYYY-MM-DD 风格的日期显示（无年份时省略，与 Obsidian 的短日期一致） */
export function formatDate(d: Date): string {
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number): string => String(n).padStart(2, "0");
  const y = d.getFullYear();
  const md = `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return y === new Date().getFullYear() ? md : `${y}-${md}`;
}