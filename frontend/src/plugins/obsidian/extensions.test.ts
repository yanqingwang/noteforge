/**
 * 自定义扩展名由插件接管的整条链。
 *
 * 起因：用户问「.mdx 有正确显示么」——答案是**没有**，而且不报任何错。
 * quadrant-chart 用 `registerExtensions(['mdx'], VIEW_TYPE_QUADRANT)` 声明接管，
 * 但兼容层的 registerExtensions 是空实现，宿主也不按扩展名路由，
 * 于是 .mdx 被当附件打开，只看到一坨 frontmatter YAML。
 *
 * 三段都要守住：
 *   1. registerExtensions 真的登记了「扩展名 → 视图类型」
 *   2. setViewState 会调 view.setState（FileView 子类靠它解析 this.file）
 *   3. 宿主按扩展名路由 + 触发 file-open
 */

import { describe, it, expect, vi } from "vitest";
import { createMemoryHost, createObsidianApi } from "./index";

function setup() {
  const host = createMemoryHost({ "a.md": "x", "象限图示例.mdx": "---\nquadrant-chart: 1\n---\n" });
  const containers = new Map<string, HTMLElement>();
  const api = createObsidianApi(host, {
    name: "t",
    workspaceHooks: {
      activeFile: () => "象限图示例.mdx",
      openFile: async () => undefined,
      getLeafContainer: (type: string) => {
        if (!containers.has(type)) {
          const d = document.createElement("div");
          d.className = `nf-leaf nf-leaf-${type}`;
          document.body.appendChild(d);
          containers.set(type, d);
        }
        return containers.get(type)!;
      },
    },
  });
  const m = api.module as Record<string, new (...a: never[]) => Record<string, unknown>>;
  // 索引要先就绪，否则 getAbstractFileByPath 一律返回 null（测试里表现为 file-open 收不到文件）
  return { api, m, ready: api.vault.ensure() };
}

describe("registerExtensions：插件接管自定义扩展名", () => {
  it("登记扩展名归属，并能按扩展名反查视图类型", async () => {
    const { api, m, ready } = setup();
    await ready;
    const ws = api.workspace as unknown as {
      registerExtension(ext: string, type: string): void;
      viewTypeForExtension(ext: string): string | null;
      registeredExtensions(): string[];
    };
    class P extends (m.Plugin as unknown as new (app: unknown, manifest: unknown) => {
      registerExtensions(exts: unknown[], viewType: string): void;
    }) {
      registerExtensions(exts: unknown[], viewType: string): void {
        super.registerExtensions(exts, viewType);
      }
    }
    const plugin = new P(api.app, { id: "quadrant-chart", name: "Quadrant Chart", version: "1.2.5" });
    plugin.registerExtensions(["mdx"], "quadrant-chart");

    expect(ws.viewTypeForExtension("mdx")).toBe("quadrant-chart");
    expect(ws.viewTypeForExtension(".mdx")).toBe("quadrant-chart");
    expect(ws.viewTypeForExtension("MDX")).toBe("quadrant-chart");
    expect(ws.viewTypeForExtension("png")).toBeNull();
    expect(ws.registeredExtensions()).toContain("mdx");
    // viewRegistry 也要能查到 —— 插件常拿它判断「有没有视图能处理这个扩展名」
    const vr = api.app.viewRegistry as unknown as { typeByExtension(ext: string): string };
    expect(vr.typeByExtension("mdx")).toBe("quadrant-chart");
  });

  it("setViewState 会调 view.setState —— FileView 子类靠它拿到 this.file", async () => {
    const { api, m, ready } = setup();
    await ready;
    type ChartView = {
      file: { path: string } | null;
      setState(state: unknown, result: unknown): Promise<void>;
      onOpen(): Promise<void>;
      getViewType(): string;
    };
    const FileView = m.FileView as unknown as new (leaf: unknown) => ChartView;
    const leaf = api.workspace.getLeaf(true);
    api.workspace.registerView("chart", (lf: unknown) => {
      const v = new FileView(lf);
      v.getViewType = () => "chart";
      return v as never;
    });
    await leaf.setViewState({ type: "chart", active: true, state: { file: "象限图示例.mdx" } });
    // 少了 setState 调用时这里会是 null，视图"打开了但没有内容"
    expect((leaf.view as unknown as ChartView | undefined)?.file?.path).toBe("象限图示例.mdx");
  });

  it("宿主按扩展名打开文件时走插件视图，并触发 file-open", async () => {
    const { api, m, ready } = setup();
    await ready;
    const opened: string[] = [];
    // 模拟 App.readNote 的路由：问 workspace 有没有视图接管这个扩展名
    const viewType = (api.workspace as unknown as { viewTypeForExtension(e: string): string | null })
      .viewTypeForExtension("mdx");
    expect(viewType).toBeNull(); // 还没注册

    type ChartView2 = {
      file: { path: string } | null;
      setState(state: unknown, result: unknown): Promise<void>;
      onOpen(): Promise<void>;
    };
    const FileView2 = m.FileView as unknown as new (leaf: unknown) => ChartView2;
    api.workspace.registerView("quadrant-chart", (lf: unknown) => new FileView2(lf) as never);
    (api.workspace as unknown as { registerExtension(e: string, t: string): void }).registerExtension(
      "mdx",
      "quadrant-chart",
    );

    const type2 = (api.workspace as unknown as { viewTypeForExtension(e: string): string | null })
      .viewTypeForExtension("mdx");
    expect(type2).toBe("quadrant-chart");

    // file-open 监听器（插件靠它接管打开流程）
    const wsEvents = api.workspace as unknown as {
      on(name: string, cb: (...a: unknown[]) => void): unknown;
      trigger(name: string, ...args: unknown[]): void;
    };
    wsEvents.on("file-open", (f) => {
      const file = f as { path?: string; extension?: string };
      if (file?.extension === "mdx") opened.push(file.path ?? "");
    });

    const leaf = api.workspace.getLeaf(true);
    await leaf.setViewState({ type: "quadrant-chart", active: true, state: { file: "象限图示例.mdx" } });
    wsEvents.trigger("file-open", api.vault.getAbstractFileByPath("象限图示例.mdx"));

    expect(opened).toEqual(["象限图示例.mdx"]);
    expect((leaf.view as unknown as ChartView2 | undefined)?.file?.path).toBe("象限图示例.mdx");
  });

  it("没被接管的扩展名不受影响（图片仍走附件查看器", async () => {
    const { api, ready } = setup();
    await ready;
    const ws = api.workspace as unknown as { viewTypeForExtension(e: string): string | null };
    expect(ws.viewTypeForExtension("png")).toBeNull();
    expect(ws.viewTypeForExtension("md")).toBeNull();
  });
});

describe("openView 带 state（宿主侧集成）", () => {
  it("把 state 交给视图，视图能解析出文件", async () => {
    const files: Record<string, string> = {
      ".obsidian/plugins/qc/manifest.json": JSON.stringify({
        id: "qc",
        name: "QC",
        version: "1.0.0",
      }),
      ".obsidian/plugins/qc/main.js": `
var obsidian = require("obsidian");
var View = obsidian.ItemView;
class P extends obsidian.Plugin {
  onload() {
    this.registerExtensions(["mdx"], "chart");
    this.registerView("chart", (leaf) => new ChartView(leaf, this));
  }
}
class ChartView extends obsidian.FileView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; }
  getViewType() { return "chart"; }
  canAcceptExtension(ext) { return ext === "mdx"; }
  async onOpen() {
    var el = this.contentEl || this.containerEl;
    el.setText("chart:" + (this.file ? this.file.path : "none"));
  }
}
module.exports = P;
`,
      ".obsidian/community-plugins.json": JSON.stringify(["qc"]),
    };
    vi.resetModules();
    const reads: string[] = [];
    vi.doMock("@tauri-apps/api/core", () => ({
      invoke: async (cmd: string, args: Record<string, unknown>) => {
        if (cmd === "list_plugins") {
          return [{ id: "qc", name: "QC", version: "1.0.0", enabled: true, has_main: true }];
        }
        if (cmd === "read_file") {
          const p = String(args.path);
          if (p.endsWith("main.js") || p.endsWith("manifest.json")) return files[p];
          throw new Error(`文件不存在: ${p}`);
        }
        if (cmd === "list_dir") return [];
        throw new Error(`未 mock: ${cmd}`);
      },
    }));
    const { obsidianRuntime } = await import("../obsidianRuntime");
    await obsidianRuntime.init({
      vaultPath: () => "/tmp/nf-ext-test",
      activeFile: () => null,
      openFile: async (p: string) => {
        reads.push(p);
      },
      ensureViewContainer: async () => null,
      openPluginSettings: () => undefined,
    });
    // 插件 onload 里 registerExtensions('mdx')
    expect(obsidianRuntime.viewTypeForExtension("mdx")).toBe("chart");
    expect(obsidianRuntime.viewTypeForExtension("png")).toBeNull();

    await obsidianRuntime.openView("chart", { file: "象限图示例.mdx" });
    const dockText = document.body.textContent ?? "";
    expect(dockText).toContain("chart:象限图示例.mdx");

    obsidianRuntime.notifyFileOpen("象限图示例.mdx");
    obsidianRuntime.dispose();
    vi.doUnmock("@tauri-apps/api/core");
  });
});