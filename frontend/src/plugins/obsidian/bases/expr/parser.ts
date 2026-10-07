/**
 * Bases 表达式语法树与 Pratt 解析器。
 *
 * 优先级（低 → 高）：三元 → `||` → `&&` → 相等 → 比较 → 加减 → 乘除模 → 一元 → 后缀。
 *
 * 有两类参数需要**延迟求值**：`list.filter(expr)` / `map(expr)` / `reduce(expr, acc)`
 * 以及汇总公式里的 `values.*`。它们的实参是 AST 节点而不是值，求值器按作用域逐项跑。
 */

import { ExprError, tokenize, type Token } from "./lexer";
import { RegexpValue } from "./values";

export type Node =
  | { kind: "number"; value: number }
  | { kind: "string"; value: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "null" }
  | { kind: "regexp"; value: RegexpValue }
  | { kind: "ident"; name: string }
  | { kind: "list"; items: Node[] }
  | { kind: "member"; object: Node; name: string }
  | { kind: "index"; object: Node; index: Node }
  | { kind: "call"; callee: Node; args: Node[] }
  | { kind: "unary"; op: "!" | "-"; operand: Node }
  | { kind: "binary"; op: BinaryOp; left: Node; right: Node }
  | { kind: "ternary"; cond: Node; then: Node; otherwise: Node };

export type BinaryOp =
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "=="
  | "!="
  | ">"
  | "<"
  | ">="
  | "<="
  | "&&"
  | "||";

/** 二元运算符优先级；数字越大越紧 */
const PREC: Record<BinaryOp, number> = {
  "||": 1,
  "&&": 2,
  "==": 3,
  "!=": 3,
  ">": 4,
  "<": 4,
  ">=": 4,
  "<=": 4,
  "+": 5,
  "-": 5,
  "*": 6,
  "/": 6,
  "%": 6,
};

const BIN_OPS = new Set<string>(Object.keys(PREC));

class Parser {
  private i = 0;
  private toks: Token[];
  constructor(toks: Token[]) {
    this.toks = toks;
  }

  private peek(): Token {
    return this.toks[this.i];
  }
  private next(): Token {
    return this.toks[this.i++];
  }
  private isPunct(v: string): boolean {
    const t = this.peek();
    return t.type === "punct" && t.value === v;
  }
  private eat(v: string): boolean {
    if (this.isPunct(v)) {
      this.i += 1;
      return true;
    }
    return false;
  }
  private expect(v: string): Token {
    if (!this.isPunct(v)) {
      const t = this.peek();
      throw new ExprError(`缺少 “${v}”（实际是 “${t.value || "结尾"}”）`, t.pos);
    }
    return this.next();
  }

  parse(): Node {
    const n = this.parseExpr(0);
    const t = this.peek();
    if (t.type !== "eof") throw new ExprError(`表达式末尾有多余内容 “${t.value}”`, t.pos);
    return n;
  }

  /** precedence climbing：minPrec 之下的一律归外层 */
  private parseExpr(minPrec: number): Node {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (t.type !== "punct") break;
      if (t.value === "?") {
        if (0 < minPrec) break;
        this.next();
        const then = this.parseExpr(0);
        this.expect(":");
        const otherwise = this.parseExpr(0);
        left = { kind: "ternary", cond: left, then, otherwise };
        continue;
      }
      if (!BIN_OPS.has(t.value)) break;
      const op = t.value as BinaryOp;
      const prec = PREC[op];
      if (prec < minPrec) break;
      this.next();
      // `**` 没有；右操作数用 prec+1 使左结合
      const right = this.parseExpr(prec + 1);
      left = { kind: "binary", op, left, right };
    }
    return left;
  }

  private parseUnary(): Node {
    const t = this.peek();
    if (t.type === "punct" && (t.value === "!" || t.value === "-")) {
      this.next();
      return { kind: "unary", op: t.value as "!" | "-", operand: this.parseUnary() };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Node {
    let obj = this.parsePrimary();
    for (;;) {
      if (this.eat(".")) {
        const t = this.next();
        if (t.type !== "ident") throw new ExprError("`.` 后面要跟属性名", t.pos);
        obj = { kind: "member", object: obj, name: t.value };
        continue;
      }
      if (this.eat("[")) {
        const idx = this.parseExpr(0);
        this.expect("]");
        obj = { kind: "index", object: obj, index: idx };
        continue;
      }
      if (this.isPunct("(")) {
        this.next();
        const args: Node[] = [];
        if (!this.isPunct(")")) {
          for (;;) {
            args.push(this.parseExpr(0));
            if (this.eat(",")) continue;
            break;
          }
        }
        this.expect(")");
        obj = { kind: "call", callee: obj, args };
        continue;
      }
      break;
    }
    return obj;
  }

  private parsePrimary(): Node {
    const t = this.next();
    if (t.type === "number") {
      const n = Number(t.value);
      if (Number.isNaN(n)) throw new ExprError(`不是合法数字 “${t.value}”`, t.pos);
      return { kind: "number", value: n };
    }
    if (t.type === "string") return { kind: "string", value: t.value };
    if (t.type === "regexp") {
      try {
        return { kind: "regexp", value: new RegexpValue(t.value, t.flags ?? "", new RegExp(t.value, t.flags ?? "")) };
      } catch (e) {
        throw new ExprError(`正则不合法：${e instanceof Error ? e.message : String(e)}`, t.pos);
      }
    }
    if (t.type === "ident") {
      if (t.value === "true") return { kind: "boolean", value: true };
      if (t.value === "false") return { kind: "boolean", value: false };
      if (t.value === "null") return { kind: "null" };
      return { kind: "ident", name: t.value };
    }
    if (t.type === "punct") {
      if (t.value === "(") {
        const inner = this.parseExpr(0);
        this.expect(")");
        return inner;
      }
      if (t.value === "[") {
        const items: Node[] = [];
        if (!this.isPunct("]")) {
          for (;;) {
            items.push(this.parseExpr(0));
            if (this.eat(",")) continue;
            break;
          }
        }
        this.expect("]");
        return { kind: "list", items };
      }
    }
    throw new ExprError(`这里不该出现 “${t.value || "结尾"}”`, t.pos);
  }
}

export function parseExpr(src: string): Node {
  if (!src || !src.trim()) throw new ExprError("表达式为空", 0);
  return new Parser(tokenize(src)).parse();
}