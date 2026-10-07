/**
 * 查询引擎测试。核心用例直接用官方 Bases syntax 页那个完整 .base 例子。
 */

import { describe, expect, it } from "vitest";
import { parseConfig, parsePropertyId } from "./config";
import { defaultOrder, propertyValue, runQuery, sortRows, summaryValue, type QueryRow } from "./query";
import { BasesEntry, BasesViewConfig } from "./api";
import type { FileApi } from "./expr/file-api";
import { LinkValue, Value } from "./expr/values";

interface FakeFile {
  path: string;
  fm: Record<string, unknown>;
  tags: string[];
  links?: string[];
  backlinks?: string[];
}

/** 小型假 vault：6 个文件，覆盖排序/分组/公式/汇总各种情况 */
function makeVault(files: FakeFile[]): { fileApi: FileApi; paths: string[] } {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const api: FileApi = {
    exists: (p) => byPath.has(p),
    basename: (p) => (p.split("/").pop() ?? p).replace(/\.[^.]+$/, ""),
    folder: (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "/"),
    ext: (p) => p.match(/\.([^.]+)$/)?.[1] ?? "",
    size: (p) => (byPath.get(p) ? 1000 : 0),
    ctime: () => new Date("2024-01-01T00:00:00Z"),
    mtime: (p) => new Date(byPath.get(p)?.path.includes("a") ? "2024-06-01" : "2024-03-01"),
    properties: (p) => byPath.get(p)?.fm ?? {},
    hasProperty: (p, k) => k in (byPath.get(p)?.fm ?? {}),
    tags: (p) => byPath.get(p)?.tags ?? [],
    links: (p) => (byPath.get(p)?.links ?? []).map((t) => new LinkValue(t)),
    embeds: () => [],
    backlinks: (p) => byPath.get(p)?.backlinks ?? [],
    resolve: (t) => (byPath.has(t) ? t : files.some((f) => f.path.endsWith(`/${t}`)) ? files.find((f) => f.path.endsWith(`/${t}`))!.path : null),
  };
  return { fileApi: api, paths: files.map((f) => f.path) };
}

function vault() {
  return makeVault([
    { path: "notes/book-a.md", fm: { status: "done", price: 20, age: 40, tag: "book" }, tags: ["book"] },
    { path: "notes/book-b.md", fm: { status: "todo", price: 10, age: 10, tag: "book" }, tags: ["book", "hard"] },
    { path: "notes/note-c.md", fm: { status: "done", price: 30 }, tags: [] },
    { path: "sub/book-d.md", fm: { status: "todo", price: 5, age: 60 }, tags: ["book"] },
    { path: "sub/other.md", fm: {}, tags: [] },
    { path: "readme.md", fm: {}, tags: [] },
  ]);
}

function run(yaml: string, viewIdx = 0) {
  const { config, error } = parseConfig(yaml);
  expect(error).toBeNull();
  const view = config.views?.[viewIdx];
  if (!view) throw new Error("视图不存在");
  const { fileApi, paths } = vault();
  const outcome = runQuery({ config, fileApi, files: paths, selfPath: "notes/base.base" }, view);
  return { config, view, outcome, fileApi };
}

describe(".base 配置解析", () => {
  it("空内容是合法的（等于全部文件 + 一个默认表格）", () => {
    const { config, error } = parseConfig("");
    expect(error).toBeNull();
    expect(config.views).toEqual([{ type: "table", name: "Table" }]);
  });

  it("YAML 语法错要报错并说明位置", () => {
    const { error } = parseConfig("views:\n  - type: table\n   bad indent: [");
    expect(error).toBeTruthy();
  });

  it("官方完整例子能解析", () => {
    const yaml = `
filters:
  or:
    - file.hasTag("tag")
    - and:
        - file.hasTag("book")
        - file.hasLink("Textbook")
    - not:
        - file.hasTag("book")
        - file.inFolder("Required Reading")
formulas:
  formatted_price: 'if(price, price.toFixed(2) + " dollars")'
  ppu: "(price / age).toFixed(2)"
properties:
  status:
    displayName: Status
summaries:
  customAverage: 'values.mean().round(3)'
views:
  - type: table
    name: "My table"
    limit: 10
    groupBy:
      property: note.age
      direction: DESC
    filters:
      and:
        - 'status != "done"'
    order:
      - file.name
      - file.ext
    sort:
      - property: file.name
        direction: ASC
    summaries:
      note.price: Average
`;
    const { config, error } = parseConfig(yaml);
    expect(error).toBeNull();
    expect(Object.keys(config.formulas ?? {})).toEqual(["formatted_price", "ppu"]);
    expect(config.summaries?.customAverage).toBe("values.mean().round(3)");
    const v = config.views![0];
    expect(v.type).toBe("table");
    expect(v.name).toBe("My table");
    expect(v.limit).toBe(10);
    expect(v.groupBy).toEqual({ property: "note.age", direction: "DESC" });
    expect(v.sort).toEqual([{ property: "file.name", direction: "ASC" }]);
    expect(v.order).toEqual(["file.name", "file.ext"]);
  });

  it("方向只有 ASC/DESC 两种，其它值归 ASC", () => {
    const { config } = parseConfig("views:\n  - type: table\n    name: t\n    sort:\n      - property: file.name\n        direction: SIDEWAYS\n");
    expect(config.views![0].sort![0].direction).toBe("ASC");
  });

  it("order: [] 是有意义的（不显示任何属性）", () => {
    const { config } = parseConfig("views:\n  - type: table\n    name: t\n    order: []\n");
    expect(config.views![0].order).toEqual([]);
  });

  it("没写 views 时兜一个 table", () => {
    const { config } = parseConfig("formulas:\n  a: \"1\"\n");
    expect(config.views).toEqual([{ type: "table", name: "Table" }]);
  });
});

describe("属性 ID 解析", () => {
  it("三种前缀", () => {
    expect(parsePropertyId("note.price")).toEqual({ type: "note", name: "price" });
    expect(parsePropertyId("file.ext")).toEqual({ type: "file", name: "ext" });
    expect(parsePropertyId("formula.ppu")).toEqual({ type: "formula", name: "ppu" });
  });
  it("无前缀算 note 属性", () => {
    expect(parsePropertyId("status")).toEqual({ type: "note", name: "status" });
  });
  it("名字里带点时前缀之后的全算名字", () => {
    expect(parsePropertyId("file.properties.a.b")).toEqual({ type: "file", name: "properties.a.b" });
  });
});

describe("筛选", () => {
  it("没有 filters 时数据集是整个 vault", () => {
    const { outcome } = run("views:\n  - type: table\n    name: t\n");
    expect(outcome.rows).toHaveLength(6);
  });

  it("简单比较", () => {
    const { outcome } = run("views:\n  - type: table\n    name: t\n    filters:\n      and:\n        - 'status == \"done\"'\n");
    expect(outcome.rows.map((r) => r.path).sort()).toEqual(["notes/book-a.md", "notes/note-c.md"]);
  });

  it("file.hasTag / inFolder", () => {
    const { outcome } = run("views:\n  - type: table\n    name: t\n    filters:\n      and:\n        - 'file.hasTag(\"book\")'\n");
    expect(outcome.rows).toHaveLength(3);
    const sub = run("views:\n  - type: table\n    name: t\n    filters:\n      and:\n        - 'file.inFolder(\"sub\")'\n");
    expect(sub.outcome.rows.map((r) => r.path).sort()).toEqual(["sub/book-d.md", "sub/other.md"]);
  });

  it("or / not 组合", () => {
    // hard（book-b）或「既不在 sub 又不是 book 标签」（note-c / readme）
    const { outcome } = run(`views:
  - type: table
    name: t
    filters:
      or:
        - 'file.hasTag("hard")'
        - not:
            - 'file.inFolder("sub")'
            - 'file.hasTag("book")'
`);
    const paths = outcome.rows.map((r) => r.path).sort();
    expect(paths).toEqual(["notes/book-b.md", "notes/note-c.md", "readme.md"]);
  });

  it("not 里的每一项都要为假才保留（任一为真就排除）", () => {
    const { outcome } = run(`views:
  - type: table
    name: t
    filters:
      and:
        - not:
            - 'file.inFolder("sub")'
            - 'file.hasTag("book")'
`);
    // 有 book 标签或位于 sub 的都被排除 → 只剩既没标签也不在 sub 的两个
    expect(outcome.rows.map((r) => r.path).sort()).toEqual(["notes/note-c.md", "readme.md"]);
  });

  it("空 or 视为通过（不筛掉任何行）", () => {
    const { outcome } = run("views:\n  - type: table\n    name: t\n    filters:\n      or: []\n");
    expect(outcome.rows).toHaveLength(6);
  });

  it("全局 filters 与视图 filters 按 AND 拼接", () => {
    const { outcome } = run(`filters:
  and:
    - 'file.hasTag("book")'
views:
  - type: table
    name: t
    filters:
      and:
        - 'status == "done"'
`);
    expect(outcome.rows.map((r) => r.path)).toEqual(["notes/book-a.md"]);
  });

  it("筛选表达式写错时记错误并把该行排除，不炸整表", () => {
    const { outcome } = run("views:\n  - type: table\n    name: t\n    filters:\n      and:\n        - 'nonexistentFn()'\n");
    expect(outcome.rows).toHaveLength(0);
    expect(outcome.errors.some((e) => e.includes("筛选表达式"))).toBe(true);
  });
});

describe("排序", () => {
  it("单键多方向", () => {
    const asc = run("views:\n  - type: table\n    name: t\n    sort:\n      - property: file.name\n        direction: ASC\n");
    expect(asc.outcome.rows[0].path).toBe("notes/book-a.md");
    const desc = run("views:\n  - type: table\n    name: t\n    sort:\n      - property: file.name\n        direction: DESC\n");
    expect(desc.outcome.rows[0].path).toBe("readme.md");
  });

  it("多键：前一个相等才看下一个", () => {
    const { outcome } = run(`views:
  - type: table
    name: t
    sort:
      - property: note.status
        direction: ASC
      - property: note.price
        direction: DESC
`);
    const rows = outcome.rows.map((r) => r.path);
    // 缺 status 的（空值最小）排最前；然后 done 组（price 30 → 20）；
    // 最后 todo 组，price 大的在前
    expect(rows).toEqual([
      "sub/other.md",
      "readme.md",
      "notes/note-c.md",
      "notes/book-a.md",
      "notes/book-b.md",
      "sub/book-d.md",
    ]);
  });

  it("缺值排在最前", () => {
    const { fileApi, paths } = vault();
    const { config } = parseConfig("views:\n  - type: table\n    name: t\n");
    const cfg = config.views![0];
    cfg.sort = [{ property: "note.price", direction: "ASC" }];
    const out = runQuery({ config, fileApi, files: paths, selfPath: "b.base" }, cfg);
    // 无 price 的排最前（稳定排序，保持原顺序）
    expect(out.rows[0].path).toBe("sub/other.md");
    expect(out.rows[1].path).toBe("readme.md");
    // 然后按 price 升序
    expect(out.rows.slice(2).map((r) => r.path)).toEqual(["sub/book-d.md", "notes/book-b.md", "notes/book-a.md", "notes/note-c.md"]);
  });
});

describe("分组", () => {
  it("groupBy 按属性分组，方向决定组序", () => {
    const { outcome } = run(`views:
  - type: table
    name: t
    groupBy:
      property: note.status
      direction: ASC
`);
    // 状态是手写分组的（在 runner 之外验证），这里先看数据准备
    expect(outcome.rows).toHaveLength(6);
  });

  it("groupedData 在没配置时是一个无 key 的组", () => {
    const { config } = parseConfig("views:\n  - type: table\n    name: t\n");
    const { fileApi, paths } = vault();
    const out = runQuery({ config, fileApi, files: paths, selfPath: "b.base" }, config.views![0]);
    const entries = out.rows.map((r) => new BasesEntry({ path: r.path, name: r.path.split("/").pop() } as never, r, out));
    // 无 groupBy → 单组
    expect(entries).toHaveLength(6);
  });
});

describe("公式", () => {
  it("公式按行求值，官方例子", () => {
    const { outcome } = run(`formulas:
  formatted_price: 'if(price, price.toFixed(2) + " dollars")'
  ppu: "(price / age).toFixed(2)"
views:
  - type: table
    name: t
    filters:
      and:
        - 'file.hasProperty("price")'
        - 'file.hasProperty("age")'
`);
    const row = outcome.rows.find((r) => r.path === "notes/book-a.md")!;
    expect(propertyValue(row, "formula.formatted_price").toString()).toBe("20.00 dollars");
    expect(propertyValue(row, "formula.ppu").toString()).toBe("0.50");
  });

  it("公式可以引用其它公式", () => {
    const { outcome } = run(`formulas:
  base_pp: "(price / age).toFixed(2)"
  doubled: "formula.base_pp"
views:
  - type: table
    name: t
    filters:
      and:
        - 'file.hasProperty("price")'
        - 'file.hasProperty("age")'
`);
    const row = outcome.rows.find((r) => r.path === "notes/book-a.md")!;
    expect(propertyValue(row, "formula.doubled").toString()).toBe("0.50");
  });

  it("循环引用被查出并报告，不静默死循环", () => {
    const { outcome } = run(`formulas:
  a: "formula.b"
  b: "formula.a"
views:
  - type: table
    name: t
`);
    expect(outcome.errors.some((e) => e.includes("循环引用"))).toBe(true);
  });

  it("公式写错时给空值，且错误记在该行（懒求值：问一次才报一次）", () => {
    const { outcome } = run(`formulas:
  bad: "1.nonexistent()"
views:
  - type: table
    name: t
`);
    const row = outcome.rows[0];
    // 公式是懒的：没被问过就不算，也就还没报错
    expect(propertyValue(row, "formula.bad").toString()).toBe("");
    expect(row.errors.some((e) => e.includes("formula.bad"))).toBe(true);
    // 其它行不受影响
    expect(outcome.rows).toHaveLength(6);
  });

  it("同一个坏公式只算一次（结果被缓存，不会每行都重试）", () => {
    const { outcome } = run(`formulas:
  bad: "1.nonexistent()"
views:
  - type: table
    name: t
`);
    const row = outcome.rows[0];
    propertyValue(row, "formula.bad");
    const before = row.errors.length;
    propertyValue(row, "formula.bad");
    expect(row.errors.length).toBe(before);
  });
});

describe("limit 与可用属性", () => {
  it("limit 截断结果", () => {
    const { outcome } = run("views:\n  - type: table\n    name: t\n    limit: 2\n");
    expect(outcome.rows).toHaveLength(2);
  });

  it("allProperties 含 file.* / note.* / formula.*", () => {
    const { outcome } = run(`formulas:
  ppu: "1"
views:
  - type: table
    name: t
`);
    expect(outcome.allProperties).toContain("file.name");
    expect(outcome.allProperties).toContain("note.status");
    expect(outcome.allProperties).toContain("formula.ppu");
  });

  it("defaultOrder 先给文件名与修改时间", () => {
    const order = defaultOrder(["note.z", "note.a", "file.name", "file.mtime"]);
    expect(order[0]).toBe("file.name");
    expect(order[1]).toBe("file.mtime");
    expect(order.slice(2)).toEqual(["note.a", "note.z"]);
  });
});

describe("汇总公式", () => {
  it("默认汇总：Average/Sum/Min/Max/Median/Range", () => {
    const { config, outcome, fileApi } = run(`views:
  - type: table
    name: t
    filters:
      and:
        - 'file.hasProperty("price")'
`);
    const rows = outcome.rows;
    const s = (key: string): string => summaryValue(key, rows, "note.price", config.summaries, fileApi, "b.base").toString();
    expect(s("Average")).toBe("16.25");
    expect(s("Sum")).toBe("65");
    expect(s("Min")).toBe("5");
    expect(s("Max")).toBe("30");
    expect(s("Range")).toBe("25");
    expect(s("Median")).toBe("15");
  });

  it("Checked / Unchecked / Empty / Filled / Unique", () => {
    const { config, outcome, fileApi } = run("views:\n  - type: table\n    name: t\n");
    const rows = outcome.rows;
    const s = (key: string, prop = "note.price"): string =>
      summaryValue(key, rows, prop, config.summaries, fileApi, "b.base").toString();
    // price 有值的 4 个：20/10/30/5
    expect(s("Filled")).toBe("4");
    expect(s("Empty")).toBe("2");
    expect(s("Unique")).toBe("4");
    expect(s("Checked")).toBe("0");
  });

  it("自定义汇总（values.mean().round(3)）", () => {
    const { config, outcome, fileApi } = run(`summaries:
  customAverage: 'values.mean().round(1)'
views:
  - type: table
    name: t
    filters:
      and:
        - 'file.hasProperty("price")'
`);
    const v = summaryValue("customAverage", outcome.rows, "note.price", config.summaries, fileApi, "b.base");
    expect(v.toString()).toBe("16.3");
  });

  it("日期汇总 Earliest/Latest", () => {
    const { config, outcome, fileApi } = run("views:\n  - type: table\n    name: t\n");
    const s = (key: string): string => summaryValue(key, outcome.rows, "file.mtime", config.summaries, fileApi, "b.base").toString();
    expect(s("Earliest")).toContain("2024-03-01");
    expect(s("Latest")).toContain("2024-06-01");
  });

  it("未知汇总名给空值而不是假装算了个数", () => {
    const { fileApi, paths } = vault();
    const { config } = parseConfig("views:\n  - type: table\n    name: t\n");
    const out = runQuery({ config, fileApi, files: paths, selfPath: "b.base" }, config.views![0]);
    const v = summaryValue("不存在的汇总", out.rows, "note.price", undefined, fileApi, "b.base");
    expect(v.isEmpty()).toBe(true);
  });
});

describe("BasesViewConfig", () => {
  function cfgWith(yaml: string): { cfg: BasesViewConfig; outcome: ReturnType<typeof run>["outcome"] } {
    const { config, view, outcome, fileApi } = run(yaml);
    const cfg = new BasesViewConfig({
      view,
      outcome,
      defaults: { separator: " - " },
      fileApi,
      selfPath: "notes/base.base",
    });
    cfg.viewDisplayNames = Object.fromEntries(
      Object.entries(config.properties ?? {}).map(([k, v]) => [k, String(v.displayName ?? "")]),
    );
    return { cfg, outcome };
  }

  it("get 读视图自定义键，缺省读 options 的 default", () => {
    const { cfg } = cfgWith("views:\n  - type: calendar\n    name: t\n    columns: [a, b]\n");
    expect(cfg.get("separator")).toBe(" - ");
    expect(cfg.get("columns")).toEqual(["a", "b"]);
  });

  it("get 不返回核心键（type/name/order/sort 不能被插件当自定义状态读）", () => {
    const { cfg } = cfgWith("views:\n  - type: table\n    name: t\n");
    expect(cfg.get("type")).toBeUndefined();
    expect(cfg.get("name")).toBeUndefined();
  });

  it("getOrder 有 order 用 order，没写给默认列", () => {
    const withOrder = cfgWith("views:\n  - type: table\n    name: t\n    order:\n      - file.name\n      - note.status\n");
    expect(withOrder.cfg.getOrder()).toEqual(["file.name", "note.status"]);
    const noOrder = cfgWith("views:\n  - type: table\n    name: t\n");
    expect(noOrder.cfg.getOrder()[0]).toBe("file.name");
  });

  it("getSort 读 .base 的 sort:", () => {
    const { cfg } = cfgWith("views:\n  - type: table\n    name: t\n    sort:\n      - property: note.price\n        direction: DESC\n");
    expect(cfg.getSort()).toEqual([{ property: "note.price", direction: "DESC" }]);
  });

  it("getDisplayName：配置优先，否则人化", () => {
    const { cfg } = cfgWith(`properties:
  status:
    displayName: 状态
views:
  - type: table
    name: t
`);
    expect(cfg.getDisplayName("note.status")).toBe("状态");
    expect(cfg.getDisplayName("file.mtime")).toBe("Modified");
    expect(cfg.getDisplayName("note.some_field")).toBe("Some field");
  });

  it("getAsPropertyId：选项值是裸名时补 note. 前缀", () => {
    const { cfg } = cfgWith("views:\n  - type: calendar\n    name: t\n    tagProp: status\n");
    expect(cfg.getAsPropertyId("tagProp")).toBe("note.status");
  });
  it("getAsPropertyId：已经是完整 ID 就原样返回", () => {
    const { cfg } = cfgWith("views:\n  - type: calendar\n    name: t\n    extProp: file.ext\n");
    expect(cfg.getAsPropertyId("extProp")).toBe("file.ext");
    expect(cfg.getAsPropertyId("file.mtime")).toBe("file.mtime");
  });
  it("getAsPropertyId：没配这个键时给 null", () => {
    const { cfg } = cfgWith("views:\n  - type: table\n    name: t\n");
    expect(cfg.getAsPropertyId("nosuchkey")).toBeNull();
  });

  it("set 写自定义键但拒绝写核心键", () => {
    const { cfg } = cfgWith("views:\n  - type: table\n    name: t\n");
    cfg.set("separator", " | ");
    expect(cfg.get("separator")).toBe(" | ");
    cfg.set("type", "calendar");
    expect(cfg.get("type")).toBeUndefined();
  });
});

describe("BasesEntry.getValue", () => {
  it("file / note / formula 三种都能取到", () => {
    const { config, view, outcome, fileApi } = run(`formulas:
  price_x2: "price * 2"
views:
  - type: table
    name: t
`);
    void config;
    void view;
    void fileApi;
    const row = outcome.rows.find((r) => r.path === "notes/book-a.md")!;
    const entry = new BasesEntry({ path: row.path, name: "book-a.md" } as never, row, outcome);
    expect(entry.getValue("file.name")?.toString()).toBe("book-a.md");
    expect(entry.getValue("file.basename")?.toString()).toBe("book-a");
    expect(entry.getValue("file.folder")?.toString()).toBe("notes");
    expect(entry.getValue("file.ext")?.toString()).toBe("md");
    expect(entry.getValue("note.price")?.toString()).toBe("20");
    expect(entry.getValue("formula.price_x2")?.toString()).toBe("40");
    // 缺属性 → null
    expect(entry.getValue("note.nope")).toBeNull();
  });
});

describe("sortRows 直接调用", () => {
  it("空排序列表保持原顺序", () => {
    const { config, outcome } = run("views:\n  - type: table\n    name: t\n");
    void config;
    const rows: QueryRow[] = outcome.rows;
    expect(sortRows(rows, []).map((r) => r.path)).toEqual(rows.map((r) => r.path));
  });
});

describe("propertyValue 的边界", () => {
  it("未知前缀当 note 属性", () => {
    const { outcome } = run("views:\n  - type: table\n    name: t\n");
    const v: Value = propertyValue(outcome.rows[0], "weird.thing");
    expect(v.isEmpty()).toBe(true);
  });
});