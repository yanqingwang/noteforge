/**
 * Bases 表达式求值。
 *
 * 属性解析按官方 Bases syntax：
 * - 无前缀标识符 → note 属性（frontmatter）
 * - `note.x` → note 属性；`note["x"]` 同理
 * - `file.*` → 文件自身属性与文件方法
 * - `formula.x` → .base 文件里定义的其它公式
 * - `this` → 上下文相关的文件（主区=base 文件本身；嵌入=宿主笔记；侧栏=活动文件）
 *
 * 编译后缓存：同一个表达式在一个 base 的所有行上求值 thousands 次，
 * 每行都重新 parse 会明显拖慢大 vault。
 */

import type { FileApi } from "./file-api";
import { ExprError } from "./lexer";
import { binaryArith, GLOBAL_FUNCTIONS, methodsFor, relational, type EvalScope, type FnCtx } from "./functions";
import { parseExpr, type Node } from "./parser";
import {
  DateValue,
  FALSE,
  FileValue,
  LinkValue,
  ListValue,
  NULL,
  NumberValue,
  ObjectValue,
  StringValue,
  TRUE,
  Value,
} from "./values";

/** 求值失败的求值结果（保留错误信息给 UI，不能静默当空） */
export class EvalError extends Error {
  readonly expr: string;
  constructor(message: string, expr: string) {
    super(message);
    this.expr = expr;
    this.name = "EvalError";
  }
}

/** 编译后的表达式：可重复求值 */
export interface Compiled {
  readonly ast: Node;
  readonly source: string;
  eval(scope: EvalScope, extra?: Record<string, Value>): Value;
}


const cache = new Map<string, Node>();

/** 编译（带缓存）。语法错误直接抛 ExprError。 */
export function compile(src: string): Compiled {
  let ast = cache.get(src);
  if (!ast) {
    ast = parseExpr(src);
    // 缓存无上限会让「用户每敲一个字符存一条」变成内存泄漏；
    // 实际用到的表达式种类很少，超过上限就整体清掉重来。
    if (cache.size > 2000) cache.clear();
    cache.set(src, ast);
  }
  return {
    ast,
    source: src,
    eval: (scope, extra) => evalNode(ast, scope, src, extra),
  };
}

/** 求值并把错误包装成 EvalError（带上原表达式，便于 UI 显示哪一条炸了） */
export function evalExpr(src: string, scope: EvalScope, extra?: Record<string, Value>): Value {
  try {
    return compile(src).eval(scope, extra);
  } catch (e) {
    if (e instanceof EvalError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof ExprError) throw new EvalError(`${msg}（位置 ${e.pos}）`, src);
    throw new EvalError(msg, src);
  }
}

function evalNode(node: Node, scope: EvalScope, src: string, extra?: Record<string, Value>): Value {
  switch (node.kind) {
    case "number":
      return new NumberValue(node.value);
    case "string":
      return new StringValue(node.value);
    case "boolean":
      return node.value ? TRUE : FALSE;
    case "null":
      return NULL;
    case "regexp":
      return node.value;
    case "list":
      return new ListValue(node.items.map((n) => evalNode(n, scope, src, extra)));
    case "ident":
      return resolveIdent(node.name, scope, extra);
    case "member":
      return evalMember(node, scope, src, extra);
    case "index":
      return evalIndex(node, scope, src, extra);
    case "call":
      return evalCall(node, scope, src, extra);
    case "unary": {
      const v = evalNode(node.operand, scope, src, extra);
      return node.op === "!" ? (v.isTruthy() ? FALSE : TRUE) : new NumberValue(-toNumber(v));
    }
    case "binary":
      return evalBinary(node, scope, src, extra);
    case "ternary":
      return evalNode(node.cond, scope, src, extra).isTruthy()
        ? evalNode(node.then, scope, src, extra)
        : evalNode(node.otherwise, scope, src, extra);
  }
}

function toNumber(v: Value): number {
  if (v instanceof NumberValue) return v.value;
  if (v instanceof DateValue) return v.value.getTime();
  const n = Number(v.toString());
  return Number.isNaN(n) ? Number.NaN : n;
}

/** 标识符解析：先看延迟绑定（filter 的 value/index/acc），再看宿主作用域 */
function resolveIdent(name: string, scope: EvalScope, extra?: Record<string, Value>): Value {
  if (extra && extra[name]) return extra[name];
  switch (name) {
    case "file":
      return scope.file;
    case "this":
      return scope.self();
    case "values":
      return scope.values ?? NULL;
  }
  // 无参全局函数允许不带括号（`today` / `now`），官方文档都写成 `today()`，
  // 但用户在公式编辑器里写 `file.mtime > today` 也应该是同一个意思
  if (NULLARY_GLOBALS.has(name)) {
    const fn = GLOBAL_FUNCTIONS[name];
    if (fn) return fn([], makeCtx(scope, "", null));
  }
  // 无前缀标识符 = note 属性（官方：If no prefix is specified, the property is
  // assumed to be a note property）
  return scope.noteProp(name);
}

/** `note.x` / `formula.x` 这类带前缀的访问（官方 Bases syntax 的三种属性） */
function prefixedValue(object: Node, prop: string, scope: EvalScope): Value | null {
  if (object.kind !== "ident") return null;
  if (object.name === "note") return scope.noteProp(prop);
  if (object.name === "formula") return scope.formula(prop) ?? NULL;
  return null;
}

function evalMember(node: { object: Node; name: string }, scope: EvalScope, src: string, extra?: Record<string, Value>): Value {
  const prefixed = prefixedValue(node.object, node.name, scope);
  if (prefixed) return prefixed;
  const obj = evalNode(node.object, scope, src, extra);
  const prop = node.name;
  if (obj instanceof ObjectValue) {
    const v = obj.get(prop);
    return v ?? NULL;
  }
  if (obj instanceof FileValue) {
    return filePropertyValue(obj.filePath, prop, scope.fileApi);
  }
  // date.year / list.length / string.length 这类"字段"也在方法表里
  const methods = methodsFor(obj);
  const fn = methods[prop];
  if (fn) return fn([obj], makeCtx(scope, src, null));
  // 未知字段：给空而不是抛 —— 属性可能只是某些行没有
  return NULL;
}

function evalIndex(node: { object: Node; index: Node }, scope: EvalScope, src: string, extra?: Record<string, Value>): Value {
  const idx = evalNode(node.index, scope, src, extra);
  const prefixed = prefixedValue(node.object, idx.toString(), scope);
  if (prefixed) return prefixed;
  const obj = evalNode(node.object, scope, src, extra);
  if (obj instanceof ListValue) {
    const i = Math.trunc(toNumber(idx));
    return obj.items[i] ?? NULL;
  }
  if (obj instanceof ObjectValue) return obj.get(idx.toString()) ?? NULL;
  if (obj instanceof FileValue) return filePropertyValue(obj.filePath, idx.toString(), scope.fileApi);
  return NULL;
}

/**
 * `file.*` 的字段属性（方法在 methodsFor 的 file 表里）。
 *
 * 导出给查询引擎复用 —— BasesEntry.getValue / 排序 / 汇总都要按属性 ID 取值，
 * 走同一个实现才不会和公式求值里的行为分叉。
 */
export function filePropertyValue(path: string, prop: string, api: FileApi): Value {
  switch (prop) {
    case "name":
      return new StringValue(path.split("/").pop() ?? path);
    case "basename":
      return new StringValue(api.basename(path));
    case "path":
      return new StringValue(path);
    case "folder":
      return new StringValue(api.folder(path));
    case "ext":
      return new StringValue(api.ext(path));
    case "size":
      return new NumberValue(api.size(path));
    case "ctime":
      return new DateValue(api.ctime(path));
    case "mtime":
      return new DateValue(api.mtime(path));
    case "properties":
      return ObjectValue.from(api.properties(path));
    case "tags":
      return new ListValue(api.tags(path).map((t) => new StringValue(t)));
    case "links":
      return new ListValue(api.links(path));
    case "embeds":
      return new ListValue(api.embeds(path));
    case "backlinks":
      return new ListValue(api.backlinks(path).map((p) => new FileValue(p)));
    case "file":
      return new FileValue(path);
    default:
      return NULL;
  }
}

/**
 * 求值上下文。
 *
 * `argOffset` 是关键：方法调用的 args[0] 是**接收者**，而实参 AST 数组里没有它，
 * 所以 expressionArg(i) 要按 i - argOffset 去取。全局函数的 offset 是 0。
 */
function makeCtx(scope: EvalScope, src: string, astArgs: Node[] | null, argOffset = 0): FnCtx {
  return {
    scope,
    evalNode: (n, extra) => evalNode(n, scope, src, extra),
    expressionArg: (i) => astArgs?.[i - argOffset] ?? null,
  };
}

function evalCall(node: { callee: Node; args: Node[] }, scope: EvalScope, src: string, extra?: Record<string, Value>): Value {
  const callee = node.callee;
  // 全局函数：if(...) / today() / file(...)
  if (callee.kind === "ident") {
    const g = GLOBAL_FUNCTIONS[callee.name];
    if (g) {
      const args = node.args.map((n) => evalNode(n, scope, src, extra));
      return g(args, makeCtx(scope, src, node.args));
    }
  }
  // 方法调用："a".contains("b") / [1,2].map(...) / file.hasTag("x")
  if (callee.kind === "member") {
    const obj = evalNode(callee.object, scope, src, extra);
    const fn = methodsFor(obj)[callee.name];
    if (fn) {
      const lazy = obj instanceof ListValue ? LAZY_METHODS.get(callee.name) : undefined;
      // 方法表的函数都按 args[0] 是接收者写，所以要把 obj 放在最前
      const args: Value[] = [obj];
      node.args.forEach((a, i) => {
        args.push(lazy?.has(i) ? NULL : evalNode(a, scope, src, extra));
      });
      // argOffset=1：args[0] 是接收者，实参 AST 从下标 0 开始
      return fn(args, makeCtx(scope, src, node.args, 1));
    }
    throw new EvalError(`${obj.typeName()} 没有 “${callee.name}” 方法`, src);
  }
  throw new EvalError("这个表达式不能调用", src);
}

/** 可以不带括号使用的无参全局函数 */
const NULLARY_GLOBALS = new Set(["today", "now", "random"]);

/** 方法名 → 需要延迟求值的实参下标。filter/map/reduce 的第 1 个实参是表达式。 */
const LAZY_METHODS = new Map<string, Set<number>>([
  ["filter", new Set([1])],
  ["map", new Set([1])],
  ["reduce", new Set([1])],
]);

function evalBinary(
  node: { op: string; left: Node; right: Node },
  scope: EvalScope,
  src: string,
  extra?: Record<string, Value>,
): Value {
  const op = node.op;
  // 短路：&& 与 ||
  if (op === "&&") {
    const l = evalNode(node.left, scope, src, extra);
    if (!l.isTruthy()) return FALSE;
    return evalNode(node.right, scope, src, extra).isTruthy() ? TRUE : FALSE;
  }
  if (op === "||") {
    const l = evalNode(node.left, scope, src, extra);
    if (l.isTruthy()) return TRUE;
    return evalNode(node.right, scope, src, extra).isTruthy() ? TRUE : FALSE;
  }
  const a = evalNode(node.left, scope, src, extra);
  const b = evalNode(node.right, scope, src, extra);
  switch (op) {
    case "==":
      return a.looseEquals(b) ? TRUE : FALSE;
    case "!=":
      return a.looseEquals(b) ? FALSE : TRUE;
    case ">":
    case "<":
    case ">=":
    case "<=":
      return relational(op, a, b);
    default:
      return binaryArith(op as "+" | "-" | "*" | "/" | "%", a, b);
  }
}

/** 判断某个值「相等」的语义入口（表格排序/筛选共用） */
export function valuesEqual(a: Value, b: Value): boolean {
  return a.looseEquals(b);
}

/** 链接 → 文件（BasesEntry 之外也可能用到） */
export function linkToFile(v: Value): string | null {
  if (v instanceof LinkValue) return v.path || null;
  if (v instanceof FileValue) return v.filePath;
  return null;
}