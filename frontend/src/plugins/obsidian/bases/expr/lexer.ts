/**
 * Bases 表达式词法分析。
 *
 * 语法与官方 Bases syntax 一致（见 obsidian.md/help/bases/syntax）：
 * 算术/比较/布尔运算符、三元、成员访问、索引、调用、字符串、正则字面量、列表字面量。
 *
 * 一个坑：`/` 既是除号也是正则字面量的开头。判定规则与 JS 词法一致 ——
 * 前面紧邻的**有效** token 若能结束一个值（数字/字符串/标识符/`)`/`]`），
 * 当前的 `/` 就是除号，否则是正则开头。
 */

export type TokenType =
  | "number"
  | "string"
  | "ident"
  | "regexp"
  | "punct"
  | "eof";

export interface Token {
  type: TokenType;
  /** number/string/regexp/ident 的字面文本，punct 是符号本身 */
  value: string;
  /** 正则的 flags */
  flags?: string;
  pos: number;
}

export class ExprError extends Error {
  readonly pos: number;
  constructor(message: string, pos: number) {
    super(message);
    this.pos = pos;
    this.name = "ExprError";
  }
}

/** 能作为表达式左操作数结束的 token 类型（决定 `/` 是除号还是正则开头） */
function endsValue(t: Token | null): boolean {
  if (!t) return false;
  if (t.type === "number" || t.type === "string" || t.type === "ident" || t.type === "regexp") return true;
  return t.type === "punct" && (t.value === ")" || t.value === "]");
}

/** 长的运算符先匹配，避免把 `==` 切成两个 `=` */
const PUNCTS = [
  "&&",
  "||",
  "==",
  "!=",
  ">=",
  "<=",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  ",",
  ".",
  "+",
  "-",
  "*",
  "/",
  "%",
  "<",
  ">",
  "!",
  "?",
  ":",
  "=",
];

export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  let prev: Token | null = null;
  const push = (t: Token): Token => {
    out.push(t);
    prev = t;
    return t;
  };

  while (i < src.length) {
    const ch = src[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i += 1;
      continue;
    }
    // 注释：`//` 到行尾。过滤表达式里写注释是常见用法。
    if (ch === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      i = nl < 0 ? src.length : nl;
      continue;
    }
    // 数字
    if (ch >= "0" && ch <= "9") {
      const start = i;
      while (i < src.length && src[i] >= "0" && src[i] <= "9") i += 1;
      // 小数点：后面必须是数字，否则 `1.toFixed()` 会被读成 `1.`（官方文档就有这种写法）
      if (src[i] === "." && src[i + 1] >= "0" && src[i + 1] <= "9") {
        i += 1;
        while (i < src.length && src[i] >= "0" && src[i] <= "9") i += 1;
      }
      if (src[i] === "e" || src[i] === "E") {
        const save = i;
        i += 1;
        if (src[i] === "+" || src[i] === "-") i += 1;
        if (src[i] >= "0" && src[i] <= "9") {
          while (i < src.length && src[i] >= "0" && src[i] <= "9") i += 1;
        } else {
          i = save;
        }
      }
      push({ type: "number", value: src.slice(start, i), pos: start });
      continue;
    }
    // 字符串：单/双引号都可（官方文档说 "must be enclosed in single or double quotes"）
    if (ch === '"' || ch === "'") {
      const quote = ch;
      const start = i;
      i += 1;
      let buf = "";
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\" && i + 1 < src.length) {
          const esc = src[i + 1];
          buf += esc === "n" ? "\n" : esc === "t" ? "\t" : esc === "r" ? "\r" : esc;
          i += 2;
          continue;
        }
        buf += src[i];
        i += 1;
      }
      if (i >= src.length) throw new ExprError("字符串没有闭合", start);
      i += 1;
      push({ type: "string", value: buf, pos: start });
      continue;
    }
    // 标识符（含 this / true / false / null，后面在 parser 里分流）
    if (/[A-Za-z_$一-龥]/.test(ch)) {
      const start = i;
      i += 1;
      while (i < src.length && /[\w$一-龥]/.test(src[i])) i += 1;
      push({ type: "ident", value: src.slice(start, i), pos: start });
      continue;
    }
    // 正则字面量：/ 不处于「除号」位置时
    if (ch === "/" && !endsValue(prev)) {
      const start = i;
      i += 1;
      let inClass = false;
      let buf = "";
      let closed = false;
      while (i < src.length) {
        const c = src[i];
        if (c === "\\" && i + 1 < src.length) {
          buf += c + src[i + 1];
          i += 2;
          continue;
        }
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) {
          i += 1;
          closed = true;
          break;
        } else if (c === "\n") break;
        buf += c;
        i += 1;
      }
      if (!closed) throw new ExprError("正则没有闭合", start);
      const fStart = i;
      while (i < src.length && /[a-z]/.test(src[i])) i += 1;
      push({ type: "regexp", value: buf, flags: src.slice(fStart, i), pos: start });
      continue;
    }
    // 标点/运算符
    const p = PUNCTS.find((op) => src.startsWith(op, i));
    if (p) {
      push({ type: "punct", value: p, pos: i });
      i += p.length;
      continue;
    }
    throw new ExprError(`无法识别的字符 “${ch}”`, i);
  }
  out.push({ type: "eof", value: "", pos: src.length });
  return out;
}