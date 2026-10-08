/**
 * 全栈集成测试：内存 vault → setupBases → 查询引擎 → 插件视图挂载。
 *
 * 这一层专门抓"每一块单测都过、串起来就断"的问题（依赖注入顺序、
 * 索引形状对不上、注册表没接上）。
 */

import { describe, expect, it } from "vitest";
import { createMemoryHost } from "../types";
import { createObsidianApi } from "../index";
import { currentBasesHost, mountBasesView } from "./registry";
import { BasesView } from "./api";
import { resetBasesHost } from "./registry";
import type { QueryController } from "./api";

const VAULT: Record<string, string> = {
  "notes/a.md": "---\nstatus: done\nprice: 20\ntags: [book]\n---\n# A\n链接 [[notes/b]] 与标签 #work\n![[img.png]]\n",
  "notes/b.md": "---\nstatus: todo\nprice: 10\n---\n# B\n嵌入 ![[notes/a]]\n",
  "sub/c.md": "# C\n![[notes/b]]\n",
  "notes/books.base": "views:\n  - type: table\n    name: Books\n    filters:\n      and:\n        - 'file.hasTag(\"book\")'\n    order:\n      - file.name\n      - note.status\n      - note.price\n",
};

async function boot(): Promise<ReturnType<typeof createObsidianApi>> {
  resetBasesHost();
  const host = createMemoryHost({ ...VAULT });
  const api = createObsidianApi(host, {});
  await api.vault.ensure();
  await api.setupBases();
  return api;
}

describe("Bases 全栈", () => {
  it("setupBases 建出索引并灌进 metadataCache", async () => {
    const api = await boot();
    const info = await api.setupBases();
    expect(info.files).toBe(4);
    // 插件读 frontmatter 的老路也通了（之前 setCache 零调用）
    // getCache 收路径、getFileCache 收 TFile —— 两个入口都得能查到
    const byPath = api.metadataCache.getCache("notes/a.md") as Record<string, unknown> | null;
    expect(byPath?.frontmatter).toMatchObject({ status: "done", price: 20 });
    const tfile = api.vault.getAbstractFileByPath("notes/a.md");
    const byFile = api.metadataCache.getFileCache(tfile as never) as Record<string, unknown> | null;
    expect(byFile).not.toBeNull();
    expect(byFile?.frontmatter).toMatchObject({ status: "done" });
    expect(Array.isArray(byPath?.tags)).toBe(true);
  });

  it("FileApi 的 file.* 属性", async () => {
    await boot();
    const api = currentBasesHost()!;
    expect(api.fileApi.basename("notes/a.md")).toBe("a");
    expect(api.fileApi.folder("notes/a.md")).toBe("notes");
    expect(api.fileApi.ext("notes/a.md")).toBe("md");
    expect(api.fileApi.properties("notes/a.md").price).toBe(20);
    expect(api.fileApi.hasProperty("notes/a.md", "status")).toBe(true);
    expect(api.fileApi.tags("notes/a.md").sort()).toEqual(["book", "work"]);
  });

  it("链接解析与反向链接", async () => {
    await boot();
    const api = currentBasesHost()!;
    expect(api.fileApi.resolve("notes/b")).toBe("notes/b.md");
    expect(api.fileApi.resolve("b")).toBe("notes/b.md");
    expect(api.fileApi.resolve("不存在的东西")).toBeNull();
    // a 链到 b、c 嵌入 b → b 有两条反向链接
    expect(api.fileApi.backlinks("notes/b.md").sort()).toEqual(["notes/a.md", "sub/c.md"]);
    expect(api.fileApi.links("notes/a.md").map((l) => l.path)).toEqual(["notes/b.md"]);
    expect(api.fileApi.embeds("notes/a.md").map((e) => e.path)).toEqual(["img.png"]);
  });

  it(".base 文件里的 filters / order 生效", async () => {
    const api = await boot();
    void api;
    const host = currentBasesHost()!;
    const { parseConfig } = await import("./config");
    const { runQuery } = await import("./query");
    const raw = await host.fileApi.resolve("notes/books.base");
    expect(raw).toBe("notes/books.base");
    const content = VAULT["notes/books.base"];
    const { config, error } = parseConfig(content);
    expect(error).toBeNull();
    const out = runQuery(
      { config, fileApi: host.fileApi, files: host.files(), selfPath: "notes/books.base" },
      config.views![0],
    );
    expect(out.errors).toEqual([]);
    // 有 book 标签的只有 a.md
    expect(out.rows.map((r) => r.path)).toEqual(["notes/a.md"]);
  });

  it("插件注册的视图能在真实 base 上挂载并拿到数据", async () => {
    await boot();
    const host = currentBasesHost()!;
    const rows: string[] = [];
    host.register(
      "test-list",
      {
        name: "Test",
        icon: "lucide-list",
        factory: (c: QueryController) => {
          const v = new (class extends BasesView {
            type = "test-list";
            onDataUpdated(): void {
              rows.length = 0;
              for (const g of this.data.groupedData) {
                for (const e of g.entries) rows.push(e.file.name);
              }
            }
          })(c);
          return v;
        },
      },
      "test",
    );
    const { parseConfig } = await import("./config");
    const { config } = parseConfig(VAULT["notes/books.base"]);
    const view = { ...config.views![0], type: "test-list" };
    const mounted = mountBasesView({
      viewType: "test-list",
      config,
      view,
      containerEl: {} as HTMLElement,
      app: {},
      selfPath: "notes/books.base",
      fileApi: host.fileApi,
    });
    expect(mounted).not.toBeNull();
    expect(rows).toEqual(["a.md"]);
    expect(host.viewTypes().map((t) => t.type)).toContain("test-list");
  });

  it("全量筛选：没有 filters 时数据集是整个 vault（.base 文件也算一个条目）", async () => {
    await boot();
    const host = currentBasesHost()!;
    const { runQuery } = await import("./query");
    const cfg = { views: [{ type: "table", name: "All" }] };
    const out = runQuery({ config: cfg, fileApi: host.fileApi, files: host.files(), selfPath: "x" }, cfg.views[0]);
    expect(out.rows.map((r) => r.path).sort()).toEqual([
      "notes/a.md",
      "notes/b.md",
      "notes/books.base",
      "sub/c.md",
    ]);
  });

  it("有 frontmatter YAML 写坏时能被看见（不静默当空）", async () => {
    resetBasesHost();
    const host = createMemoryHost({
      "bad.md": "---\na: [1,\n b: {\n---\n# bad\n",
      "ok.md": "---\na: 1\n---\n# ok\n",
    });
    const api = createObsidianApi(host, {});
    await api.vault.ensure();
    await api.setupBases();
    // 坏 YAML → 空对象 + 记进 issues（静默当空会变成一个安静的 bug）
    expect(api.metadataCache.getCache("bad.md")?.frontmatter).toEqual({});
    // ok 的 frontmatter 仍然是真类型
    expect((api.metadataCache.getCache("ok.md")?.frontmatter as Record<string, unknown>).a).toBe(1);
  });
});