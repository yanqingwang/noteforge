/**
 * Obsidian 兼容层的单元测试。
 *
 * 重点是「加载必需」的那几条路径：文件句柄、vault 读写、插件生命周期与命令注册、
 * CJS 产物求值、设置组件 DOM。这些一旦出错，表现是整片插件白屏或 onload 崩溃。
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryHost } from "./types";
import { createObsidianApi, OBSIDIAN_EXPORT_NAMES } from "./index";
import { TFile, TFolder } from "./items";
import { normalizePath, getAllTags, parseLinktext, Scope, debounce } from "./events";
import { getFrontMatterInfo, parseFrontMatterTags } from "./extra";
import { moment } from "./request";
import { evaluatePlugin } from "../loader";
import { createCmModules } from "./cm-modules";

const SEED = {
  "A.md": "# A\n\n[[B]]\n",
  "sub/B.md": "---\ntags: [x, y]\n---\n\n# B\n",
  "sub/img.png": "not-a-png",
};

function api() {
  const host = createMemoryHost(SEED);
  return { host, a: createObsidianApi(host, { name: "t" }) };
}

describe("文件句柄", () => {
  it("TFile 拆出 basename/extension", () => {
    const f = new TFile("a/b/笔记.md");
    expect(f.basename).toBe("笔记");
    expect(f.extension).toBe("md");
    expect(f.name).toBe("笔记.md");
    expect(new TFile("x").extension).toBe("");
  });

  it("TFolder 判定根目录", () => {
    expect(new TFolder("").isRoot()).toBe(true);
    expect(new TFolder("sub").isRoot()).toBe(false);
  });

  it("normalizePath 统一分隔符并去掉首尾斜杠", () => {
    expect(normalizePath("/a//b/")).toBe("a/b");
    expect(normalizePath("a\\b\\c.md")).toBe("a/b/c.md");
  });
});

describe("Vault", () => {
  it("查询方法是同步的（Obsidian 语义：直接返回数组/对象）", async () => {
    const { a } = api();
    await a.vault.ensure();
    const md = a.vault.getMarkdownFiles();
    // 不 await 直接用数组方法 —— 插件里就是这么写的
    expect(Array.isArray(md)).toBe(true);
    expect(md.map((f) => f.path).sort()).toEqual(["A.md", "sub/B.md"]);
    expect(a.vault.getAllFolders().map((f) => f.path)).toEqual(["sub"]);
    expect(a.vault.getFileByPath("A.md")?.basename).toBe("A");
    expect(a.vault.getFileByPath("不存在.md")).toBeNull();
    expect(md.find((f) => f.path === "sub/B.md")?.extension).toBe("md");
  });

  it("create → read → modify → delete 全链路", async () => {
    const { a } = api();
    await a.vault.ensure();
    const f = await a.vault.create("sub/new.md", "hello");
    expect(f.path).toBe("sub/new.md");
    expect(await a.vault.read(f)).toBe("hello");
    await a.vault.modify(f, "hello2");
    expect(await a.vault.read(f)).toBe("hello2");
    await a.vault.delete(f);
    expect(a.vault.getFileByPath("sub/new.md")).toBeNull();
  });

  it("create 会补齐缺失的父目录", async () => {
    const { a } = api();
    await a.vault.ensure();
    const f = await a.vault.create("x/y/z.md", "c");
    expect(a.vault.getFolderByPath("x/y")).not.toBeNull();
    expect(f.parent?.path).toBe("x/y");
  });

  it("modify 触发 modify 事件（插件靠它做自动刷新）", async () => {
    const { a } = api();
    await a.vault.ensure();
    const seen: string[] = [];
    a.vault.on("modify", (f) => seen.push((f as TFile)?.path ?? ""));
    const f = a.vault.getFileByPath("A.md");
    await a.vault.modify(f!, "changed");
    expect(seen).toContain("A.md");
  });

  it("cachedRead 与 read 一致", async () => {
    const { a } = api();
    await a.vault.ensure();
    const f = a.vault.getFileByPath("A.md");
    expect(await a.vault.cachedRead(f!)).toBe(await a.vault.read(f!));
  });
});

describe("插件生命周期", () => {
  const manifest = { id: "demo", name: "Demo", version: "1.0.0" };

  /** 插件基类的最小结构（测试里只需要用到的方法签名）。 */
  type PluginLike = {
    manifest: { id: string };
    onload(): void;
    onunload(): void;
    addCommand(c: { id: string; name: string; callback(): void }): { id: string };
    registerEvent(ref: unknown): void;
    getCommands(): Array<{ id: string }>;
    getSettingTabs(): unknown[];
    registerView(t: string, f: unknown): void;
    loadData(): Promise<unknown>;
    saveData(d: unknown): Promise<void>;
  };
  type PluginCtor = new (app: unknown, m: unknown) => PluginLike;

  it("命令注册进 app.commands，卸载后清理", () => {
    const { a } = api();
    const Base = a.module.Plugin as unknown as PluginCtor;
    class Real extends Base {
      onload() {
        this.addCommand({ id: "hello", name: "打个招呼", callback: () => undefined });
      }
      onunload() {}
    }
    const p = new Real(a.app, manifest);
    p.onload();
    const cmd = a.app.commands.commands["demo:hello"];
    expect(cmd).toBeTruthy();
    expect(cmd.name).toBe("打个招呼");
    expect(() => a.app.commands.executeCommandById("demo:hello")).not.toThrow();
    p.onunload();
  });

  it("registerView 的视图工厂进入 workspace", () => {
    const { a } = api();
    const Base = a.module.Plugin as unknown as PluginCtor;
    class WithView extends Base {
      onload() {
        this.registerView("demo-view", () => ({}) as never);
      }
      onunload() {}
    }
    new WithView(a.app, manifest).onload();
    expect(a.workspace.registeredViewTypes()).toContain("demo-view");
  });

  it("视图类型集合可读，供宿主准备容器", () => {
    const { a } = api();
    expect(Array.isArray(a.workspace.registeredViewTypes())).toBe(true);
  });

  it("loadData/saveData 落在 Obsidian 约定的 data.json", async () => {
    const { host, a } = api();
    const Base = a.module.Plugin as unknown as PluginCtor;
    class P2 extends Base {
      onload() {}
      onunload() {}
      addCommand() {
        return { id: "" };
      }
      registerEvent() {}
      getCommands() {
        return [];
      }
      getSettingTabs() {
        return [];
      }
      registerView() {}
    }
    const p = new P2(a.app, { id: "demo2", name: "D2", version: "1" });
    expect(await p.loadData()).toBeNull();
    await p.saveData({ a: 1 });
    expect(JSON.parse(await host.fs.read(".obsidian/plugins/demo2/data.json"))).toEqual({ a: 1 });
    expect(await p.loadData()).toEqual({ a: 1 });
  });
});

describe("工具函数", () => {
  it("getAllTags 合并 frontmatter 与缓存标签", () => {
    expect(getAllTags({ frontmatter: { tags: ["a", "b"] }, tags: ["c"] })).toEqual(["a", "b", "c"]);
    expect(getAllTags(null)).toBeNull();
  });

  it("parseLinktext 拆路径/锚点/别名", () => {
    expect(parseLinktext("a/b#h")).toEqual({ path: "a/b", subpath: "#h", alias: "" });
    expect(parseLinktext("note|显示")).toEqual({ path: "note", subpath: "", alias: "显示" });
  });

  it("getFrontMatterInfo 定位 frontmatter 区间", () => {
    const info = getFrontMatterInfo("---\ntags: [a, b]\n---\n\n正文");
    expect(info.exists).toBe(true);
    expect(info.frontmatter).toContain("tags");
    expect(info.contentStart).toBeGreaterThan(0);
    expect(getFrontMatterInfo("# 无 frontmatter").exists).toBe(false);
  });

  it("parseFrontMatterTags 取数组或字符串", () => {
    expect(parseFrontMatterTags("---\ntags: [a, b]\n---\n")).toEqual(["a", "b"]);
    expect(parseFrontMatterTags("---\ntags: solo\n---\n")).toEqual(["solo"]);
    expect(parseFrontMatterTags("# 无")).toEqual([]);
  });

  it("moment 支持 format 与 locale（4/41 样本插件加载期就调 locale）", () => {
    expect(moment("2026-01-02T03:04:05Z").format("YYYY-MM-DD")).toBe("2026-01-02");
    expect(moment.locale("zh")).toBe("zh");
    expect(moment.locales()).toContain("zh");
  });

  it("Scope 阻止重复键注册并在 unregister 后释放", () => {
    const s = new Scope();
    const h = () => undefined;
    s.register("Mod-x", h);
    expect(() => s.register("Mod-x", h)).toThrow(/已注册/);
    s.unregister(h);
    expect(() => s.register("Mod-x", h)).not.toThrow();
  });

  it("debounce 合并连续调用", async () => {
    let n = 0;
    const fn = debounce(() => { n++; }, 5);
    fn();
    fn();
    fn();
    await new Promise((r) => setTimeout(r, 30));
    expect(n).toBe(1);
  });
});

describe("CJS 加载器", () => {
  const manifest = { id: "cjs", name: "CJS", version: "1.0.0" };

  it("能加载 esbuild 风格的 CJS 插件并完成 onload", async () => {
    const { a } = api();
    // 等价于 esbuild 产物：module.exports.default = class extends require("obsidian").Plugin
    const code = `
var obsidian = require("obsidian");
class P extends obsidian.Plugin {
  onload() { this.addCommand({ id: "go", name: "走", callback: () => {} }); }
}
module.exports = __toCommonJS(P);
function __toCommonJS(x) {
  return Object.assign({}, x, { default: x });
}
`;
    const ev = evaluatePlugin(code, {
      filename: "/p/main.js",
      requireMap: { obsidian: a.module, ...createCmModules() },
    });
    expect(ev.error).toBeUndefined();
    const Cls = ev.defaultExport as new (app: unknown, m: unknown) => {
      onload(): void;
      onunload(): void;
    };
    const p = new Cls(a.app, manifest);
    p.onload();
    expect(a.app.commands.commands["cjs:go"]).toBeTruthy();
  });

  it("未提供的模块在真正使用时报错，而不是加载期静默失败", () => {
    const { a } = api();
    const code = `var m = require("totally-missing-pkg"); module.exports = { v: m.thing };`;
    const ev = evaluatePlugin(code, { filename: "/p/main.js", requireMap: { obsidian: a.module } });
    expect(ev.error?.message).toContain("未提供模块");
    expect(ev.unresolved).toContain("totally-missing-pkg");
  });

  it("installNodeGlobals 提供 process/global/Buffer", () => {
    const ev = evaluatePlugin(`module.exports = { hasProcess: typeof process !== "undefined" };`, {
      filename: "/p/main.js",
      requireMap: {},
    });
    expect(ev.exports.hasProcess).toBe(true);
  });
});

describe("导出清单", () => {
  it("关键导出都在（含 41 插件静态分析补齐的那批）", () => {
    const must = [
      "Plugin", "PluginSettingTab", "Setting", "ItemView", "MarkdownView", "Notice", "Modal",
      "SuggestModal", "AbstractInputSuggest", "EditorSuggest", "MarkdownRenderChild", "TFile",
      "TFolder", "TAbstractFile", "Vault", "Workspace", "WorkspaceLeaf", "requestUrl", "moment",
      "normalizePath", "setIcon", "getIcon", "getLanguage", "getLinkpath", "CodeMirror",
      "editorInfoField", "editorLivePreviewField", "Scope", "parseYaml", "stringifyYaml",
      "getFrontMatterInfo", "SettingGroup", "SettingPage", "TextFileView", "ConfirmationModal",
    ];
    for (const k of must) expect(OBSIDIAN_EXPORT_NAMES).toContain(k);
  });
});

describe("DOM 扩展（Obsidian 挂在原型上的便捷方法）", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("createEl/createDiv/setText/empty 走通", () => {
    const root = document.createElement("div");
    const child = root.createDiv({ cls: "x", text: "hi" });
    expect(child.className).toBe("x");
    expect(child.textContent).toBe("hi");
    root.empty();
    expect(root.childNodes.length).toBe(0);
  });

  it("class 辅助方法", () => {
    const el = document.createElement("div");
    el.addClass("a", "b");
    expect(el.hasClass("a")).toBe(true);
    el.removeClass("a");
    expect(el.hasClass("a")).toBe(false);
    el.toggleClass(["c"], true);
    expect(el.classList.contains("c")).toBe(true);
  });

  it("全局 createEl 与 createFragment 存在", () => {
    expect(typeof (globalThis as Record<string, unknown>).createEl).toBe("function");
    expect(typeof (globalThis as Record<string, unknown>).createFragment).toBe("function");
  });
});
