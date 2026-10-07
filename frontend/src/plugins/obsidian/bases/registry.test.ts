/**
 * 插件自定义 Bases 视图的挂载测试。
 *
 * 视图代码用的是官方 developer guide（docs.obsidian.md/plugins/guides/bases-view）
 * 里那份 MyBasesView 的真实实现 —— 那三个失败的插件（calendar-bases /
 * social-archiver / media-extended）也是这个形状。
 */

import { beforeEach, describe, expect, it } from "vitest";
import { BasesEntry, BasesEntryGroup, BasesQueryResult, BasesView, BasesViewConfig, QueryController } from "./api";
import { parseConfig } from "./config";
import { ensureBasesHost, groupEntries, mountBasesView, resetBasesHost } from "./registry";
import type { FileApi } from "./expr/file-api";
import { LinkValue } from "./expr/values";

const FILES: Record<string, Record<string, unknown>> = {
  "notes/a.md": { status: "done", price: 20 },
  "notes/b.md": { status: "todo", price: 10 },
  "sub/c.md": { status: "done" },
};

function api(): FileApi {
  return {
    exists: (p) => p in FILES,
    basename: (p) => (p.split("/").pop() ?? p).replace(/\.[^.]+$/, ""),
    folder: (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "/"),
    ext: (p) => p.match(/\.([^.]+)$/)?.[1] ?? "",
    size: () => 100,
    ctime: () => new Date("2024-01-01T00:00:00Z"),
    mtime: () => new Date("2024-06-01T00:00:00Z"),
    properties: (p) => FILES[p] ?? {},
    hasProperty: (p, k) => k in (FILES[p] ?? {}),
    tags: (p) => (p === "notes/a.md" ? ["work"] : []),
    links: (p) => (p === "notes/a.md" ? [new LinkValue("notes/b.md")] : []),
    embeds: () => [],
    backlinks: () => [],
    resolve: (t) => (t in FILES ? t : null),
  };
}

/** 官方 guide 里的示例视图（去掉 DOM 依赖的部分，只验数据通路） */
class ExampleBasesView extends BasesView {
  readonly type = "example-view";
  rows: string[] = [];
  groups: BasesEntryGroup[] = [];
  configSnapshot: BasesViewConfig | null = null;
  propsSeen: string[] = [];
  calls = 0;

  onDataUpdated(): void {
    this.calls += 1;
    this.configSnapshot = this.config;
    this.groups = this.data.groupedData;
    this.rows = [];
    this.propsSeen = [];
    const order = this.config.getOrder();
    const separator = String(this.config.get("separator")) || " - ";
    for (const group of this.groups) {
      for (const entry of group.entries) {
        const parts: string[] = [];
        for (const propertyName of order) {
          const value = entry.getValue(propertyName);
          if (!value || !value.isTruthy()) continue;
          if (propertyName === "file.name") parts.push(entry.file.name);
          else parts.push(value.toString());
        }
        this.rows.push(parts.join(separator));
      }
    }
  }
}

describe("插件 Bases 视图挂载", () => {
  beforeEach(() => {
    resetBasesHost();
  });

  function mount(yaml: string, viewIdx = 0) {
    const host = ensureBasesHost(api());
    host.filesFn = () => Object.keys(FILES);
    const views: Array<{ instance: ExampleBasesView }> = [];
    const container = { appendChild: () => {} } as unknown as HTMLElement;
    const ok = host.register(
      "example-view",
      {
        name: "Example",
        icon: "lucide-graduation-cap",
        factory: (controller: QueryController, el: HTMLElement) => {
          const v = new ExampleBasesView(controller);
          void el;
          views.push({ instance: v });
          return v;
        },
        options: () => [
          { type: "text", displayName: "Property separator", key: "separator", default: " - " },
        ],
      },
      "test-plugin",
    );
    expect(ok).toBe(true);
    const { config, error } = parseConfig(yaml);
    expect(error).toBeNull();
    const view = config.views![viewIdx];
    const mounted = mountBasesView({
      viewType: "example-view",
      config,
      view,
      containerEl: container,
      app: {},
      selfPath: "notes/books.base",
      fileApi: api(),
    });
    return { mounted, views, view };
  }

  it("register 返回 false（viewId 重复）", () => {
    const host = ensureBasesHost(api());
    const reg = { name: "A", icon: "x", factory: () => new ExampleBasesView({} as QueryController) };
    expect(host.register("dup", reg)).toBe(true);
    expect(host.register("dup", reg)).toBe(false);
    host.unregister("dup");
    expect(host.register("dup", reg)).toBe(true);
  });

  it("factory 产出的视图拿到 config / data / allProperties 并被 onDataUpdated 调过", () => {
    const { views } = mount("views:\n  - type: example-view\n    name: Example\n");
    const v = views[0].instance;
    expect(v.calls).toBe(1);
    expect(v.config).toBeInstanceOf(BasesViewConfig);
    expect(v.data).toBeInstanceOf(BasesQueryResult);
    expect(v.allProperties).toContain("file.name");
    expect(v.data.properties).toContain("file.name");
    expect(v.controller).toBeInstanceOf(QueryController);
  });

  it("没配 filters 时数据是整个 vault（官方语义）", () => {
    const { views } = mount("views:\n  - type: example-view\n    name: Example\n");
    expect(views[0].instance.data.data).toHaveLength(3);
  });

  it("options() 的 default 能通过 config.get 读到（guide 第 3 步）", () => {
    const { views } = mount("views:\n  - type: example-view\n    name: Example\n");
    // 默认值是 " - "，视图里 String(config.get('separator')) || ' - ' 都能拿到
    expect(views[0].instance.config?.get("separator")).toBe(" - ");
  });

  it(".base 里存的视图状态覆盖 options 默认值", () => {
    const { views } = mount("views:\n  - type: example-view\n    name: Example\n    separator: \" | \"\n");
    expect(views[0].instance.config?.get("separator")).toBe(" | ");
  });

  it("按 guide 的方式遍历 groupedData + getOrder + getValue 能拿到全部数据", () => {
    const { views } = mount(`views:
  - type: example-view
    name: Example
    order:
      - file.name
      - note.status
      - note.price
`);
    const v = views[0].instance;
    expect(v.rows).toContain("a.md - done - 20");
    expect(v.rows).toContain("b.md - todo - 10");
    // c.md 没有 price → 那一项跳过（guide 里就是 `if (!value) continue`）
    expect(v.rows).toContain("c.md - done");
  });

  it("filters / sort / limit 生效", () => {
    const { views } = mount(`views:
  - type: example-view
    name: Example
    filters:
      and:
        - 'status == "done"'
    sort:
      - property: file.name
        direction: DESC
    order:
      - file.name
`);
    expect(views[0].instance.rows).toEqual(["c.md", "a.md"]);
  });

  it("groupBy 产出多个分组，group 内含各自的 entries", () => {
    const { views } = mount(`views:
  - type: example-view
    name: Example
    groupBy:
      property: note.status
      direction: ASC
`);
    const groups = views[0].instance.groups;
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.hasKey())).toBe(true);
    // ASC: done < todo
    expect(groups[0].key?.toString()).toBe("done");
    expect(groups[0].entries).toHaveLength(2);
    expect(groups[1].key?.toString()).toBe("todo");
  });

  it("groupOrder 决定顺序与可见性（null 项是「无值」那组）", () => {
    const { views } = mount(`views:
  - type: example-view
    name: Example
    groupBy:
      property: note.status
      direction: ASC
    groupOrder:
      - todo
      - done
`);
    const groups = views[0].instance.groups;
    expect(groups.map((g) => g.key?.toString())).toEqual(["todo", "done"]);
  });

  it("groupOrder 里的空值组用 null 指定（只列出可见的组）", () => {
    const { views } = mount(`views:
  - type: example-view
    name: Example
    groupBy:
      property: note.price
    groupOrder:
      - 10
      - null
`);
    const groups = views[0].instance.groups;
    // price 有三档：20 / 10 / 缺值。groupOrder 只列了 10 与 null → 20 那组不显示
    expect(groups).toHaveLength(2);
    expect(groups[0].key?.toString()).toBe("10");
    expect(groups[0].entries.map((e) => e.file.name)).toEqual(["b.md"]);
    expect(groups[1].hasKey()).toBe(false);
    expect(groups[1].entries.map((e) => e.file.name)).toEqual(["c.md"]);
  });

  it("groupOrder 为空数组 → 所有组都不显示（官方语义）", () => {
    const { views } = mount(`views:
  - type: example-view
    name: Example
    groupBy:
      property: note.price
    groupOrder: []
`);
    expect(views[0].instance.groups).toHaveLength(0);
  });

  it("没注册的类型挂载返回 null（不抛）", () => {
    const host = ensureBasesHost(api());
    host.filesFn = () => Object.keys(FILES);
    const { config } = parseConfig("views:\n  - type: 没注册的类型\n    name: x\n");
    const r = mountBasesView({
      viewType: "没注册的类型",
      config,
      view: config.views![0],
      containerEl: {} as HTMLElement,
      app: {},
      selfPath: "x.base",
      fileApi: api(),
    });
    expect(r).toBeNull();
  });

  it("factory 抛错时挂载返回 null 而不是炸掉整个 base", () => {
    const host = ensureBasesHost(api());
    host.filesFn = () => Object.keys(FILES);
    host.register("boom", {
      name: "Boom",
      icon: "x",
      factory: () => {
        throw new Error("factory 炸了");
      },
    });
    const { config } = parseConfig("views:\n  - type: boom\n    name: x\n");
    const r = mountBasesView({
      viewType: "boom",
      config,
      view: config.views![0],
      containerEl: {} as HTMLElement,
      app: {},
      selfPath: "x.base",
      fileApi: api(),
    });
    expect(r).toBeNull();
  });

  it("refresh 重算并再调一次 onDataUpdated", () => {
    const { mounted, views } = mount("views:\n  - type: example-view\n    name: Example\n    order:\n      - file.name\n");
    const v = views[0].instance;
    expect(v.calls).toBe(1);
    mounted!.refresh();
    expect(v.calls).toBe(2);
  });

  it("getSummaryValue 能算（走宿主的自定义汇总）", () => {
    const { views } = mount(`summaries:
  avg2: 'values.mean().round(1)'
views:
  - type: example-view
    name: Example
    filters:
      and:
        - 'file.hasProperty("price")'
`);
    const v = views[0].instance;
    const entries = v.data.data.filter((e) => e.file.path === "notes/a.md" || e.file.path === "notes/b.md");
    expect(v.data.getSummaryValue(v.controller, entries, "note.price", "Average").toString()).toBe("15");
  });

  it("viewTypes 列出内置 + 插件注册的", () => {
    const host = ensureBasesHost(api());
    host.register("my-view", { name: "我的", icon: "lucide-star", factory: () => new ExampleBasesView({} as QueryController) });
    const types = host.viewTypes();
    expect(types.filter((t) => t.builtin).map((t) => t.type)).toEqual(["table", "list"]);
    expect(types.find((t) => t.type === "my-view")?.name).toBe("我的");
  });

  it("BasesEntry.getValue 对缺属性给 null", () => {
    const { views } = mount("views:\n  - type: example-view\n    name: Example\n");
    const entry = views[0].instance.data.data[0];
    expect(entry).toBeInstanceOf(BasesEntry);
    expect(entry.getValue("note.price")).not.toBeNull();
    expect(entry.getValue("note.没有这个属性")).toBeNull();
  });
});

describe("groupEntries 直接调用", () => {
  it("无 groupBy 时是一个无 key 的组", () => {
    expect(groupEntries([], { type: "table", name: "t" })).toHaveLength(1);
    expect(groupEntries([], { type: "table", name: "t" })[0].hasKey()).toBe(false);
  });
});