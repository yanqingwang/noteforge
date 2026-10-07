/**
 * obsidianRuntime 的集成测试（mock 掉 Tauri invoke）。
 *
 * 覆盖的是「真机上最容易出错的那条链」：读 manifest/main.js → CJS 求值 →
 * 插件构造 → onload → 命令/视图/设置页进入 UI 可见的列表。
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const PLUGIN_MAIN = `
var obsidian = require("obsidian");
class Demo extends obsidian.Plugin {
  onload() {
    this.addCommand({ id: "hello", name: "打招呼", callback: () => { globalThis.__nfPluginRan = true; } });
    this.registerView("demo-view", (leaf) => {
      const { ItemView } = obsidian;
      return new (class extends ItemView {
        constructor(l) { super(l); this.contentEl.textContent = "demo view body"; }
        getViewType() { return "demo-view"; }
        getDisplayText() { return "Demo 视图"; }
      })(leaf);
    });
    this.addSettingTab(new (class extends obsidian.PluginSettingTab {
      display() { this.containerEl.textContent = "demo settings"; }
    })(this.app, this));
    this.registerEditorExtension({ name: "demo-ext" });
  }
}
module.exports = Demo;
`;

const VAULT = "/tmp/nf-test-vault";

const FILES: Record<string, string> = {
  ".obsidian/plugins/demo/manifest.json": JSON.stringify({
    id: "demo", name: "Demo 插件", version: "1.2.3", description: "测试用", author: "t",
  }),
  ".obsidian/plugins/demo/main.js": PLUGIN_MAIN,
  ".obsidian/plugins/demo/styles.css": ".demo-style{color:red}",
  ".obsidian/plugins/off/manifest.json": JSON.stringify({ id: "off", name: "未启用", version: "0.1" }),
  ".obsidian/plugins/off/main.js": "throw new Error('不应被加载');",
  ".obsidian/community-plugins.json": JSON.stringify(["demo"]),
  "A.md": "# A",
};

/**
 * 把 invoke mock 成读一张内存文件表。
 * vi.mock 会被提升到顶层，所以共享状态要用 vi.hoisted 暴露出来。
 */
const mocks = vi.hoisted(() => ({ files: {} as Record<string, string> }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    const files = mocks.files;
    switch (cmd) {
      case "list_plugins": {
        // 与 Rust 端一致：路径都是 vault 相对路径
        const prefix = ".obsidian/plugins/";
        const enabled = JSON.parse(files[".obsidian/community-plugins.json"] ?? "[]") as string[];
        const out: unknown[] = [];
        for (const [path, content] of Object.entries(files)) {
          if (!path.startsWith(prefix) || !path.endsWith("manifest.json")) continue;
          const id = path.slice(prefix.length).split("/")[0];
          const mf = JSON.parse(content) as Record<string, string>;
          out.push({
            id,
            name: mf.name,
            version: mf.version,
            description: mf.description ?? "",
            author: mf.author ?? "",
            enabled: enabled.includes(id),
            has_main: files[`${prefix}${id}/main.js`] !== undefined,
            bytes: files[`${prefix}${id}/main.js`]?.length ?? 0,
          });
        }
        return out;
      }
      case "read_file": {
        const p = String(args.path);
        if (!(p in files)) throw new Error(`文件不存在: ${p}`);
        return files[p];
      }
      default:
        throw new Error(`未 mock 的命令: ${cmd}`);
    }
  },
}));


describe("obsidianRuntime 集成", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.files = { ...FILES };
  });

  it("加载启用插件并暴露命令/视图/设置页", async () => {
    const { obsidianRuntime } = await import("./obsidianRuntime");
    await obsidianRuntime.init({
      vaultPath: () => VAULT,
      activeFile: () => `${VAULT}/A.md`,
      openFile: async () => undefined,
      ensureViewContainer: async () => null,
    });

    const list = obsidianRuntime.list();
    expect(list.map((p) => p.id).sort()).toEqual(["demo", "off"]);

    const demo = list.find((p) => p.id === "demo")!;
    expect(demo.error).toBeNull();
    expect(demo.loaded).toBe(true);
    expect(demo.version).toBe("1.2.3");
    expect(demo.commands).toEqual(["打招呼"]);
    expect(demo.views).toContain("demo-view");
    expect(demo.hasSettings).toBe(true);

    // 未启用的插件不能被加载（main.js 里有 throw，被加载就会暴露）
    expect(list.find((p) => p.id === "off")!.loaded).toBe(false);

    // 命令要出现在宿主可枚举的列表里
    const cmds = obsidianRuntime.commands();
    expect(cmds.map((c) => c.id)).toContain("demo:hello");
    expect(cmds[0].name).toContain("[插件]");

    // 设置页能渲染出内容
    const tabs = obsidianRuntime.settingTabsOf("demo");
    expect(tabs).toHaveLength(1);
    expect(tabs[0].el.textContent).toContain("demo settings");

    obsidianRuntime.dispose();
  });

  it("执行插件命令会真的调用插件的 callback", async () => {
    const { obsidianRuntime } = await import("./obsidianRuntime");
    await obsidianRuntime.init({
      vaultPath: () => VAULT,
      activeFile: () => null,
      openFile: async () => undefined,
      ensureViewContainer: async () => null,
    });
    const cmd = obsidianRuntime.commands().find((c) => c.id === "demo:hello")!;
    (globalThis as Record<string, unknown>).__nfPluginRan = false;
    cmd.run();
    expect((globalThis as Record<string, unknown>).__nfPluginRan).toBe(true);
    obsidianRuntime.dispose();
  });

  it("插件的 styles.css 会被注入，且 unload 后移除", async () => {
    const { obsidianRuntime } = await import("./obsidianRuntime");
    await obsidianRuntime.init({
      vaultPath: () => VAULT,
      activeFile: () => null,
      openFile: async () => undefined,
      ensureViewContainer: async () => null,
    });
    const style = document.querySelector<HTMLStyleElement>('style[data-noteforge-plugin="demo"]');
    expect(style?.textContent).toContain(".demo-style");
    obsidianRuntime.dispose();
    await new Promise((r) => setTimeout(r, 0));
    expect(document.querySelector('style[data-noteforge-plugin="demo"]')).toBeNull();
  });

  it("加载失败的插件要报告错误而不是整体崩掉", async () => {
    vi.resetModules();
    mocks.files = {
      ...FILES,
      ".obsidian/plugins/broken/manifest.json": JSON.stringify({ id: "broken", name: "坏插件", version: "0" }),
      ".obsidian/plugins/broken/main.js": "module.exports = class { constructor(){ throw new Error('boom'); } };",
      ".obsidian/community-plugins.json": JSON.stringify(["demo", "broken"]),
    };
    const { obsidianRuntime } = await import("./obsidianRuntime");
    await obsidianRuntime.init({
      vaultPath: () => VAULT,
      activeFile: () => null,
      openFile: async () => undefined,
      ensureViewContainer: async () => null,
    });
    const broken = obsidianRuntime.list().find((p) => p.id === "broken")!;
    expect(broken.loaded).toBe(false);
    expect(broken.error).toContain("boom");
    // 其它插件照常工作
    expect(obsidianRuntime.list().find((p) => p.id === "demo")!.loaded).toBe(true);
    obsidianRuntime.dispose();
  });

  it("openView 把插件视图挂进宿主给的容器", async () => {
    const { obsidianRuntime } = await import("./obsidianRuntime");
    const host = document.createElement("div");
    document.body.appendChild(host);
    await obsidianRuntime.init({
      vaultPath: () => VAULT,
      activeFile: () => null,
      openFile: async () => undefined,
      ensureViewContainer: async () => host,
    });
    await obsidianRuntime.openView("demo-view");
    expect(host.childNodes.length).toBeGreaterThan(0);
    expect(host.textContent ?? "").toContain("demo view body");
    obsidianRuntime.dispose();
    host.remove();
  });
});
