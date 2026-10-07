import { describe, expect, it } from "vitest";
import { IndexStore, type MetaIndexRaw } from "./index-store";

function storeWith(files: Partial<MetaIndexRaw["files"][number]>[], backlinks: Record<string, string[]> = {}): IndexStore {
  const raw: MetaIndexRaw = {
    files: files.map((f) => ({
      path: "a.md",
      ext: "md",
      size: 1,
      mtime_ms: 2,
      ctime_ms: 3,
      frontmatter: null,
      tags: [],
      links: [],
      embeds: [],
      headings: [],
      ...f,
    })),
    backlinks,
    scanned: files.length,
    skipped: 0,
  };
  const s = new IndexStore(async () => raw);
  s.adopt(raw);
  return s;
}

describe("IndexStore frontmatter 真解析", () => {
  it("数值/布尔/日期保持原类型（行解析会全变字符串）", () => {
    const s = storeWith([
      {
        path: "n.md",
        frontmatter: "age: 30\ndone: true\ndue: 2026-01-02\nscore: 1.5\ntitle: Hi",
      },
    ]);
    const fm = s.frontmatterOf("n.md");
    expect(fm.age).toBe(30);
    expect(typeof fm.age).toBe("number");
    expect(fm.done).toBe(true);
    expect(typeof fm.done).toBe("boolean");
    // yaml 包默认把日期解析成 Date（YAML 1.1 core schema）
    expect(fm.due instanceof Date || fm.due === "2026-01-02").toBe(true);
    expect(fm.score).toBe(1.5);
    expect(fm.title).toBe("Hi");
  });

  it("嵌套对象与块状数组", () => {
    const s = storeWith([
      {
        path: "n.md",
        frontmatter: "meta:\n  a: 1\nlist:\n  - x\n  - y\ntags:\n  - t1\n",
      },
    ]);
    const fm = s.frontmatterOf("n.md");
    expect(fm.meta).toEqual({ a: 1 });
    expect(fm.list).toEqual(["x", "y"]);
  });

  it("没有 frontmatter 时是空对象，不报错", () => {
    const s = storeWith([{ path: "n.md", frontmatter: null }]);
    expect(s.frontmatterOf("n.md")).toEqual({});
    expect(s.getFrontmatterIssues()).toHaveLength(0);
  });

  it("YAML 写坏了要能被看见（记 issue，不是静默当空）", () => {
    const s = storeWith([{ path: "bad.md", frontmatter: "a: [1,\n  b: {" }]);
    expect(s.frontmatterOf("bad.md")).toEqual({});
    const issues = s.getFrontmatterIssues();
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe("bad.md");
  });

  it("frontmatter 不是映射时报 issue", () => {
    const s = storeWith([{ path: "list.md", frontmatter: "- a\n- b" }]);
    expect(s.frontmatterOf("list.md")).toEqual({});
    expect(s.getFrontmatterIssues()[0].error).toContain("键值映射");
  });
});

describe("IndexStore 标签合并", () => {
  it("行内标签 + frontmatter tags 三种写法都吃", () => {
    const s = storeWith([
      { path: "n.md", tags: ["inline", "#hash"], frontmatter: "tags: [a, b]" },
      { path: "m.md", tags: [], frontmatter: "tags: c, d" },
      { path: "l.md", tags: [], frontmatter: "tags:\n  - e\n  - f" },
    ]);
    expect(s.allTagsOf("n.md")).toEqual(["a", "b", "hash", "inline"]);
    expect(s.allTagsOf("m.md")).toEqual(["c", "d"]);
    expect(s.allTagsOf("l.md")).toEqual(["e", "f"]);
  });
});

describe("IndexStore 查询接口", () => {
  it("backlinks / file / stamp", () => {
    const s = storeWith([{ path: "target.md" }, { path: "src.md" }], { "target.md": ["src.md"] });
    expect(s.backlinksOf("target.md")).toEqual(["src.md"]);
    expect(s.backlinksOf("nope.md")).toEqual([]);
    expect(s.has("src.md")).toBe(true);
    expect(s.file("src.md")?.path).toBe("src.md");
    expect(s.stampOf("src.md")).toEqual({ mtimeMs: 2, size: 1 });
    expect(s.stampOf("nope.md")).toBeNull();
  });

  it("toCacheEntry 是插件能直接用的 CachedMetadata 形状", () => {
    const s = storeWith([
      {
        path: "n.md",
        frontmatter: "status: done",
        tags: ["t"],
        links: [{ target: "x", path: "x.md", display: "X", subpath: null }],
        embeds: [{ target: "img.png", path: "img.png", display: null, subpath: null }],
        headings: [{ level: 2, text: "H" }],
      },
    ]);
    const cache = s.toCacheEntry("n.md") as Record<string, unknown>;
    expect(cache.frontmatter).toEqual({ status: "done" });
    expect(cache.tags).toEqual(["t"]);
    expect((cache.links as Array<{ link: string }>)[0].link).toBe("x.md");
    expect((cache.embeds as unknown[]).length).toBe(1);
    expect((cache.headings as Array<{ heading: string }>)[0].heading).toBe("H");
    expect(s.toCacheEntry("missing.md")).toBeNull();
  });
});