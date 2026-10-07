/**
 * 表达式引擎测试 —— 用例直接取自官方文档的例子
 * （obsidian.md/help/bases/syntax 与 /help/bases/functions）。
 */

import { describe, expect, it } from "vitest";
import type { EvalScope } from "./functions";
import type { FileApi } from "./file-api";
import { compile, EvalError, evalExpr } from "./evaluate";
import { FileValue, fromJs, LinkValue, ListValue, NumberValue, StringValue } from "./values";

/** 最小 FileApi：几个固定文件，够测 file.* 与 inFolder/hasLink */
function fileApi(): FileApi {
  const files: Record<string, Record<string, unknown>> = {
    "notes/a.md": { status: "done", age: 30, title: "Note A", tags: ["work", "done"] },
    "notes/deep/b.md": { status: "todo", age: 20 },
    "sub/c.md": {},
  };
  const links: Record<string, string[]> = {
    "notes/a.md": ["notes/deep/b.md"],
  };
  const backlinks: Record<string, string[]> = {
    "notes/deep/b.md": ["notes/a.md"],
  };
  return {
    exists: (p) => p in files,
    basename: (p) => (p.split("/").pop() ?? p).replace(/\.[^.]+$/, ""),
    folder: (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "/"),
    ext: (p) => (p.match(/\.([^.]+)$/)?.[1] ?? ""),
    size: (p) => files[p] ? 100 : 0,
    ctime: () => new Date(`2024-01-01T00:00:00Z`),
    mtime: () => new Date(`2024-06-01T00:00:00Z`),
    properties: (p) => files[p] ?? {},
    hasProperty: (p, k) => k in (files[p] ?? {}),
    tags: (p) => (files[p]?.tags as string[] | undefined) ?? [],
    links: (p) => (links[p] ?? []).map((t) => new LinkValue(t)),
    embeds: () => [],
    backlinks: (p) => backlinks[p] ?? [],
    resolve: (t) => (t in files || t.includes(".md") || t in links || t in backlinks ? t : null),
  };
}

function scope(path = "notes/a.md", props: Record<string, unknown> = {}, self = "notes/a.md"): EvalScope {
  const api = fileApi();
  const fm: Record<string, unknown> = { ...api.properties(path), ...props };
  return {
    file: new FileValue(path),
    noteProp: (name) => fromJs(fm[name]),
    formula: () => null,
    self: () => new FileValue(self),
    fileApi: api,
  };
}

/** 求值并取字符串形式 */
function ev(src: string, path = "notes/a.md"): string {
  return evalExpr(src, scope(path)).toString();
}

function ok(src: string, path = "notes/a.md"): boolean {
  return evalExpr(src, scope(path)).isTruthy();
}

describe("算术/比较/布尔", () => {
  it("官方例子：radius * (2 * 3.14)", () => {
    expect(ev("2 * (2 * 3.14)")).toBe("12.56");
  });
  it("优先级与结合：1 + 2 * 3 与 (1 + 2) * 3", () => {
    expect(ev("1 + 2 * 3")).toBe("7");
    expect(ev("(1 + 2) * 3")).toBe("9");
    expect(ev("10 - 2 - 3")).toBe("5");
  });
  it("取模", () => {
    expect(ev("7 % 3")).toBe("1");
  });
  it("布尔运算：! && ||", () => {
    expect(ok("!false")).toBe(true);
    expect(ok("true && true")).toBe(true);
    expect(ok("false || true")).toBe(true);
    // 短路：右边不参与求值（这里靠右侧是坏表达式也能过来说明短路生效）
    expect(ok("false && 1.nonexistent()")).toBe(false);
    expect(ok("true || 1.nonexistent()")).toBe(true);
  });
  it("三元", () => {
    expect(ev('true ? "a" : "b"')).toBe("a");
    expect(ev('false ? "a" : "b"')).toBe("b");
  });
  it("字符串拼接", () => {
    expect(ev('"a" + "b"')).toBe("ab");
    expect(ev('"n=" + 5')).toBe("n=5");
  });
});

describe("数值方法（官方例子）", () => {
  it("round：默认与指定位数", () => {
    expect(ev("(2.5).round()")).toBe("3");
    expect(ev("(2.3333).round(2)")).toBe("2.33");
  });
  it("toFixed 返回字符串", () => {
    expect(ev("(3.14159).toFixed(2)")).toBe("3.14");
    expect(ev("(3.14159).toFixed(2).isType(\"string\")")).toBe("true");
  });
  it("abs/ceil/floor", () => {
    expect(ev("(-5).abs()")).toBe("5");
    expect(ev("(2.1).ceil()")).toBe("3");
    expect(ev("(2.9).floor()")).toBe("2");
  });
});

describe("字符串方法（官方例子）", () => {
  it("contains / containsAll / containsAny", () => {
    expect(ok('"hello".contains("ell")')).toBe(true);
    expect(ok('"hello".containsAll("h", "e")')).toBe(true);
    expect(ok('"hello".containsAny("x", "y", "e")')).toBe(true);
  });
  it("startsWith / endsWith", () => {
    expect(ok('"hello".startsWith("he")')).toBe(true);
    expect(ok('"hello".endsWith("lo")')).toBe(true);
  });
  it("lower / upper / title / trim", () => {
    expect(ev('"HELLO".lower()')).toBe("hello");
    expect(ev('"hello world".title()')).toBe("Hello World");
    expect(ev('"  hi  ".trim()')).toBe("hi");
  });
  it("repeat / reverse / length", () => {
    expect(ev('"123".repeat(2)')).toBe("123123");
    expect(ev('"hello".reverse()')).toBe("olleh");
    expect(ev('"hello".length')).toBe("5");
  });
  it("slice：start 闭、end 开", () => {
    expect(ev('"hello".slice(1, 4)')).toBe("ell");
    expect(ev('"hello".slice(1)')).toBe("ello");
  });
  it("split：字符串分隔与正则", () => {
    expect(ev('"a,b,c,d".split(",")')).toBe("a, b, c, d");
    expect(ev('"a,b,c,d".split(",", 3)')).toBe("a, b, c");
    expect(ev('"a:b:c".split(/:/)')).toBe("a, b, c");
  });
  it("replace：字符串替换全部、正则按 g 标志决定", () => {
    expect(ev('"a:b:c:d".replace(/:/, "-")')).toBe("a-b:c:d");
    expect(ev('"a:b:c:d".replace(/:/g, "-")')).toBe("a-b-c-d");
  });
  it("replace：正则捕获组 $1", () => {
    expect(ev('"John Smith".replace(/(\\w+) (\\w+)/, "$2, $1")')).toBe("Smith, John");
  });
  it("isEmpty", () => {
    expect(ok('"".isEmpty()')).toBe(true);
    expect(ok('"Hello world".isEmpty()')).toBe(false);
  });
});

describe("列表方法（官方例子）", () => {
  it("contains", () => {
    expect(ok("[1,2,3].contains(2)")).toBe(true);
  });
  it("filter / map：表达式实参延迟求值", () => {
    expect(ev("[1,2,3,4].filter(value > 2)")).toBe("3, 4");
    expect(ev("[1,2,3,4].map(value + 1)")).toBe("2, 3, 4, 5");
    // index 也可用
    expect(ev('["a","b"].map(value + index)')).toBe("a0, b1");
  });
  it("reduce：sum 与 max", () => {
    expect(ev("[1,2,3].reduce(acc + value, 0)")).toBe("6");
    expect(ev('[1,2,3].reduce(if(acc == null || value > acc, value, acc), null)')).toBe("3");
  });
  it("join / unique / flat / sort / reverse / slice", () => {
    expect(ev('[1,2,3].join(",")')).toBe("1,2,3");
    expect(ev("[1,2,2,3].unique()")).toBe("1, 2, 3");
    expect(ev("[1,[2,3]].flat()")).toBe("1, 2, 3");
    expect(ev("[3, 1, 2].sort()")).toBe("1, 2, 3");
    expect(ev("['c', 'a', 'b'].sort()")).toBe("a, b, c");
    expect(ev("[1,2,3].reverse()")).toBe("3, 2, 1");
    expect(ev("[1,2,3,4].slice(1,3)")).toBe("2, 3");
    expect(ev("[1,2,3].length")).toBe("3");
  });
  it("containsAny / containsAll", () => {
    expect(ok("[1,2,3].containsAll(2,3)")).toBe(true);
    expect(ok("[1,2,3].containsAny(3,4)")).toBe(true);
  });
  it("聚合（汇总公式用）", () => {
    expect(ev("[1,2,3].mean()")).toBe("2");
    expect(ev("[1,2,3].sum()")).toBe("6");
    expect(ev("[1,2,3].median()")).toBe("2");
    expect(ev("[1,2,3].max()")).toBe("3");
  });
  it("汇总公式的 values 绑定（values.mean().round(3)）", () => {
    const s = scope("notes/a.md");
    s.values = new ListValue([new NumberValue(1), new NumberValue(2), new NumberValue(4)]);
    expect(evalExpr("values.mean().round(1)", s).toString()).toBe("2.3");
  });
});

describe("日期算术（官方例子）", () => {
  it("date + 时长字符串", () => {
    expect(ev('date("2024-12-01") + "1M" + "4h" + "3m"').startsWith("2025-01-01")).toBe(true);
    expect(ev('date("2025-01-01") + "1 day"').startsWith("2025-01-02")).toBe(true);
    expect(ev('date("2025-01-01") - "2h"').includes("22:00")).toBe(true);
  });
  it("年月日用日历运算（2024-01-31 + 1M = 2024-02-29）", () => {
    expect(ev('date("2024-01-31") + "1M"').startsWith("2024-02-29")).toBe(true);
  });
  it("两日期相减得毫秒", () => {
    const ms = Number(ev('(date("2025-01-02") - date("2025-01-01"))'));
    expect(ms).toBe(86400000);
    expect(ev('(date("2025-01-02") - date("2025-01-01")) / 1000')).toBe("86400");
  });
  it("文件修改时间在最近一周内", () => {
    // 测试文件的 mtime 固定在 2024-06-01，now() 是当下 → 必然为 false
    expect(ok("file.mtime > now() - \"1 week\"")).toBe(false);
    expect(ok("file.mtime < now()")).toBe(true);
  });
  it("日期字段与方法", () => {
    expect(ev('date("2025-05-27").year')).toBe("2025");
    expect(ev('date("2025-05-27").month')).toBe("5");
    expect(ev('date("2025-05-27").day')).toBe("27");
    expect(ev('date("2025-05-27").format("YYYY-MM-DD")')).toBe("2025-05-27");
    expect(ev('date("2025-05-27").date().format("YYYY-MM-DD HH:mm:ss")')).toBe("2025-05-27 00:00:00");
  });
  it("duration：标量必须在左边", () => {
    expect(ev("(now() + duration('1d') * 2) > now()")).toBe("true");
    expect(() => ev("2 * duration('1d')")).toThrow();
  });
});

describe("file.* 与 file 方法（官方例子）", () => {
  it("文件属性", () => {
    expect(ev("file.name")).toBe("a.md");
    expect(ev("file.basename")).toBe("a");
    expect(ev("file.path")).toBe("notes/a.md");
    expect(ev("file.folder")).toBe("notes");
    expect(ev("file.ext")).toBe("md");
    expect(ev("file.size")).toBe("100");
    expect(ev("file.hasProperty(\"status\")")).toBe("true");
    expect(ev('file.ext == "md"')).toBe("true");
  });
  it("hasTag / inFolder / hasLink / asLink", () => {
    expect(ok('file.hasTag("work", "done")')).toBe(true);
    expect(ok('file.hasTag("#work")')).toBe(true);
    expect(ok('file.hasTag("nope")')).toBe(false);
    expect(ok('file.inFolder("notes")')).toBe(true);
    expect(ok('file.inFolder("notes/deep")')).toBe(false);
    expect(ok('file.inFolder("sub")')).toBe(false);
    expect(ok('file.hasLink("notes/deep/b.md")')).toBe(true);
    expect(ev("file.asLink()")).toBe("notes/a.md");
  });
  it("inFolder 命中子文件夹（官方语义）", () => {
    expect(ok('file.inFolder("sub")', "sub/deep/d.md")).toBe(true);
  });
  it("file.tags / file.links / file.backlinks", () => {
    expect(ev("file.tags.contains(\"work\")")).toBe("true");
    expect(ev("file.links.contains(link(\"notes/deep/b.md\"))")).toBe("true");
    expect(ev("file.backlinks.length")).toBe("0");
  });
  it("file.properties 里的属性", () => {
    expect(ev('file.properties.status')).toBe("done");
    expect(ev('file.properties["status"]')).toBe("done");
  });
});

describe("note 属性与前缀", () => {
  it("无前缀 = note 属性", () => {
    expect(ev('status')).toBe("done");
    expect(ev('note.status')).toBe("done");
    expect(ev('note["status"]')).toBe("done");
    expect(ok('status == "done"')).toBe(true);
    expect(ok('note.age > 25')).toBe(true);
    expect(ok('note.age > 100')).toBe(false);
  });
  it("缺属性是空值而不是报错", () => {
    expect(ev("nosuchprop")).toBe("");
    expect(ok("nosuchprop")).toBe(false);
    expect(ok("!nosuchprop")).toBe(true);
    expect(ok("nosuchprop > 1")).toBe(false);
  });
  it("this 指上下文文件（嵌入时是宿主笔记）", () => {
    const s = scope("notes/a.md", {}, "sub/c.md");
    expect(evalExpr("this.path", s).toString()).toBe("sub/c.md");
  });
});

describe("全局函数", () => {
  it("if：缺省 false 分支为 null", () => {
    expect(ev('if(true, "a")')).toBe("a");
    expect(ev('if(false, "a")')).toBe("");
    expect(ev('if(true, "a", "b")')).toBe("a");
  });
  it("list / number / max / min", () => {
    expect(ev('list("value")')).toBe("value");
    expect(ev('list(["a","b"])')).toBe("a, b");
    expect(ev('number("3.4")')).toBe("3.4");
    expect(ev("max(1, 5, 3)")).toBe("5");
    expect(ev("min(1, 5, 3)")).toBe("1");
    expect(() => ev('number("abc")')).toThrow();
  });
  it("link / image / icon / html / escapeHTML", () => {
    expect(ev('link("filename")')).toBe("filename");
    expect(ev('link("filename", "display")')).toBe("display");
    expect(ev('icon("arrow-right")')).toBe("arrow-right");
    expect(ev('escapeHTML("<b>&")')).toBe("&lt;b&gt;&amp;");
  });
  it("today 是当天零点", () => {
    const v = evalExpr("today", scope("notes/a.md"));
    expect(v.typeName()).toBe("date");
    expect(ok("today.isType(\"date\")")).toBe(true);
  });
  it("date() 解析不合法输入给出无效日期而不是崩", () => {
    expect(ev('date("不是日期").isEmpty()')).toBe("true");
  });
});

describe("对象与正则", () => {
  it("object 方法", () => {
    expect(ev('file.properties.keys().contains("status")')).toBe("true");
    expect(ev('file.properties.values().contains("done")')).toBe("true");
    expect(ok("file.properties.isEmpty()")).toBe(false);
  });
  it("正则 matches", () => {
    expect(ok('/abc/.matches("abcde")')).toBe(true);
    expect(ok('/abc/.matches("xyz")')).toBe(false);
    expect(ok('/ABC/i.matches("abc")')).toBe(true);
  });
});

describe("any 类型方法", () => {
  it("isTruthy / isType / toString", () => {
    expect(ok("1.isTruthy()")).toBe(true);
    expect(ok('"example".isType("string")')).toBe(true);
    expect(ok("true.isType(\"boolean\")")).toBe(true);
    expect(ev("123.toString()")).toBe("123");
  });
});

describe("错误可定位", () => {
  it("语法错误带位置", () => {
    expect(() => compile("1 +")).toThrow();
    expect(() => compile('"abc')).toThrow();
    expect(() => compile("")).toThrow();
  });
  it("求值错误带上原表达式", () => {
    try {
      evalExpr("1.nonexistent()", scope("notes/a.md"));
      throw new Error("本该抛错");
    } catch (e) {
      expect(e).toBeInstanceOf(EvalError);
      expect((e as EvalError).expr).toBe("1.nonexistent()");
    }
  });
  it("编译结果可重复求值且 AST 被缓存", () => {
    const c = compile("file.ext == \"md\"");
    expect(c.eval(scope("notes/a.md")).isTruthy()).toBe(true);
    expect(c.eval(scope("notes/deep/b.md")).isTruthy()).toBe(true);
    expect(compile("file.ext").ast).toBe(compile("file.ext").ast);
  });
});

describe("类型系统边界", () => {
  it("列表字面量里可以有各种类型", () => {
    expect(ev('[1, "a", true]')).toBe("1, a, true");
    expect(ok('[1, "a"].isType("list")')).toBe(true);
  });
  it("注释被忽略", () => {
    expect(ev("1 + 1 // 这是注释")).toBe("2");
  });
  it("link 与 file 互相可比较", () => {
    expect(ok('link("notes/a.md") == file')).toBe(true);
    expect(ok('link("notes/a.md").asFile() == file')).toBe(true);
  });
  it("跨类型松散相等：1 == \"1\"", () => {
    expect(new StringValue("1").looseEquals(new NumberValue(1))).toBe(true);
    expect(ok("1 == \"1\"")).toBe(true);
    expect(ok("age == \"30\"")).toBe(true);
  });
});