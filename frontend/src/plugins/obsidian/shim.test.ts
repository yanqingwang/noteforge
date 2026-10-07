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
  /**
   * 回归守卫：曾经三次犯过同一个错 —— 新 API 加进了 import/再导出，却忘了放进
   * raw 模块表（require("obsidian") 拿不到）。症状是「测试全绿、真机插件报
   * The superclass is not a constructor」。所以这里直接断言「这些名字能被插件拿到，
   * 且类名必须真的是构造器」。
   */
  it("插件会继承/使用的导出必须真的在模块表里，且是构造器", () => {
    const { a } = api();
    // 这些是真实插件在模块顶层 extends/new 的类（drawio-obsidian、iconic、
    // dataview、tasks、git… 都用过），少一个就是整包加载失败
    const classes = [
      "Plugin", "PluginSettingTab", "ItemView", "MarkdownView", "FileView",
      "EditableFileView", "TextFileView", "Modal", "SuggestModal", "FuzzySuggestModal",
      "AbstractInputSuggest", "EditorSuggest", "Menu", "Setting", "SettingPage",
      "SettingGroup", "Notice", "ButtonComponent", "ColorComponent", "DropdownComponent",
      "ExtraButtonComponent", "SearchComponent", "TextComponent", "TextAreaComponent",
      "ToggleComponent", "SliderComponent", "BaseComponent", "ValueComponent",
      "WorkspaceRoot", "WorkspaceFloating", "ConfirmationModal", "MarkdownRenderChild",
      "Component", "Events", "Scope", "TAbstractFile", "TFile", "TFolder", "Vault",
      "ImageView", "PDFView",
    ];
    for (const name of classes) {
      expect(OBSIDIAN_EXPORT_NAMES, `${name} 不在 raw 模块表里`).toContain(name);
      const v = a.module[name];
      expect(typeof v, `${name} 应是构造器/类`).toBe("function");
    }
  });

  it("插件会当函数调用的导出必须可用", () => {
    const { a } = api();
    for (const name of [
      "setIcon", "addIcon", "getIcon", "getIconIds", "getLanguage", "getLinkpath",
      "normalizePath", "parseLinktext", "parseYaml", "stringifyYaml", "debounce",
      "requestUrl", "request", "moment", "displayTooltip", "hideTooltip",
      "getFrontMatterInfo", "parseFrontMatterEntry", "parseFrontMatterTags",
      "prepareSimpleSearch", "prepareFuzzySearch", "requireApiVersion", "sanitizeHTMLToDom",
      "base64ToArrayBuffer", "arrayBufferToBase64",
    ]) {
      expect(OBSIDIAN_EXPORT_NAMES, `${name} 不在 raw 模块表里`).toContain(name);
      expect(typeof a.module[name], `${name} 应可调用`).toBe("function");
    }
  });

  it("CodeMirror（CM5 兼容命名空间）成员齐备", () => {
    const { a } = api();
    const cm = a.module.CodeMirror as Record<string, unknown>;
    expect(cm).toBeTruthy();
    for (const k of ["defineMode", "getMode", "customOverlayMode", "startState"]) {
      expect(typeof cm[k], `CodeMirror.${k} 缺失`).toBe("function");
    }
    expect(typeof cm.commands, "CodeMirror.commands 缺失").toBe("object");
    // Keymap 是 CM keymap 工厂（of / fromObject）
    const km = a.module.Keymap as Record<string, unknown>;
    expect(typeof km.of, "Keymap.of 缺失").toBe("function");
    expect(typeof km.fromObject, "Keymap.fromObject 缺失").toBe("function");
    expect(typeof (cm.commands as Record<string, unknown>).indentAuto).toBe("function");
    // MarkdownRenderer 是静态命名空间
    const mr = a.module.MarkdownRenderer as Record<string, unknown>;
    expect(typeof mr.render, "MarkdownRenderer.render 缺失").toBe("function");
  });

  it("el.on 支持 jQuery 委托写法 on(event, selector, handler)", () => {
    api();
    const parent = document.createElement("div");
    const child = document.createElement("span");
    child.className = "target";
    const other = document.createElement("b");
    parent.append(child, other);
    // 故意不挂到 document.body：前面测试留在 body 里的元素会影响冒泡统计
    const seen: string[] = [];
    // 老插件（auto-note-mover）用 el.on("mousedown", ".target", cb)
    parent.on("mousedown", ".target", function (this: HTMLElement, ev: Event) {
      // jQuery 语义：this 指向命中的元素，且只在选择器命中时才回调
      seen.push(`${(ev.target as HTMLElement).className}:${this.className}`);
    });
    child.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    const afterChild = seen.length;
    other.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect({ afterChild, afterOther: seen.length - afterChild }).toEqual({ afterChild: 1, afterOther: 0 });
    // off 能按 (event, selector, handler) 精确解绑 —— 否则插件卸载后事件还在触发
    const cb: EventListener = function () {
      seen.push("leak");
    };
    parent.on("mousedown", ".target", cb);
    parent.off("mousedown", ".target", cb);
    const before = seen.length;
    child.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    // 常驻 handler 又记了一次（说明事件确实还在派发），但被 off 掉的 cb 不能出现
    expect(seen.length - before).toBe(1);
    expect(seen).not.toContain("leak");
    parent.remove();
  });

  it("app 上有平台判定字段（插件直接读 app.isMobile）", () => {
    const { a } = api();
    const app = a.app as unknown as Record<string, unknown>;
    expect(app.isMobile).toBe(false);
    expect(app.isDesktop).toBe(true);
    expect(typeof app.isIosApp).toBe("boolean");
  });

  it("moment.localeData() 带 _week（插件读 ._week.dow）", () => {
    const { a } = api();
    const m = (a.module.moment as unknown as (v?: undefined) => {
      localeData(): { _week?: { dow?: number }; dow(): number };
    })();
    expect(m.localeData()._week?.dow).toBe(1);
    expect(typeof m.localeData().dow()).toBe("number");
  });

  it("SettingGroup(containerEl) 渲染进传入容器（否则设置页空白）", () => {
    const { a } = api();
    const host = document.createElement("div");
    document.body.appendChild(host);
    // Obsidian 签名：new SettingGroup(containerEl, { title, desc, heading })
    const g = new (a.module.SettingGroup as unknown as new (
      c: HTMLElement,
      o?: { title?: string; desc?: string; heading?: boolean },
    ) => { addSetting(cb: (s: unknown) => void): void; setName(n: string): void })(
      host,
      { title: "分组标题", desc: "分组说明", heading: true },
    );
    g.setName("改名");
    g.addSetting(() => undefined);
    // 内容必须落在 host 里，而不是游离元素
    expect(host.querySelector(".nf-setting-group")).toBeTruthy();
    expect(host.textContent).toContain("改名");
    expect(host.textContent).toContain("分组说明");
    expect(host.querySelector(".nf-setting-group.mod-heading")).toBeTruthy();
    // 旧写法 new SettingGroup("标题") 仍可用（SettingPage 走这条）
    const g2 = new (a.module.SettingGroup as unknown as new (n?: string) => { settingEl: HTMLElement })(
      "只有标题",
    );
    expect(g2.settingEl.textContent).toContain("只有标题");
    host.remove();
  });

  it("PluginSettingTab 提供 contentEl（插件的 display() 都往这里写）", () => {
    const { a } = api();
    const Tab = a.module.PluginSettingTab as unknown as new (
      app: unknown,
      plugin: unknown,
    ) => { containerEl: HTMLElement; contentEl: HTMLElement; hide(): void };
    const tab = new Tab(a.app, { manifest: { id: "x", name: "X" } });
    // Obsidian 语义：contentEl 是 containerEl 的子元素
    expect(tab.contentEl).toBeTruthy();
    expect(tab.containerEl.contains(tab.contentEl)).toBe(true);
    tab.contentEl.appendChild(document.createElement("div"));
    tab.hide();
    expect(tab.contentEl.childElementCount).toBe(0);
    // vault.configDir：插件靠它拼插件设置文件路径
    expect((a.vault as unknown as { configDir: string }).configDir).toBe(".obsidian");
  });

  it("SettingPage.addItem 传给回调的是真 Setting（不是残缺转发壳）", () => {
    const { a } = api();
    const page = new (a.module.SettingPage as new (n?: string) => {
      addItem(cb: (s: unknown) => void): void;
      addSetting(cb: (s: unknown) => void): void;
      addSearch(cb: (c: unknown) => void): void;
    })("测试");
    let got: unknown;
    page.addItem((s) => {
      got = s;
    });
    // 早先这里传的是只转发 9 个方法的 SettingImpl，插件调这些方法直接 "is not a function"
    for (const m of [
      "setName", "setDesc", "setClass", "setTooltip", "setHeading", "setDisabled",
      "addText", "addTextArea", "addSearch", "addToggle", "addDropdown", "addSlider",
      "addButton", "addExtraButton", "addButtonForCommand", "addMomentFormat",
      "addColorPicker", "then",
    ]) {
      expect(typeof (got as Record<string, unknown>)[m], `Setting.${m} 缺失`).toBe("function");
    }
    // addSetting 是 addItem 的别名，拿到的东西也必须是真 Setting
    page.addSetting((s) => {
      expect(s).toBe(got === undefined ? got : s);
      expect(typeof (s as Record<string, unknown>).addExtraButton).toBe("function");
    });
    // addSearch 必须给真 SearchComponent（早先传的是空对象）
    page.addSearch((c) => {
      expect(typeof (c as Record<string, unknown>).setValue).toBe("function");
      expect(typeof (c as Record<string, unknown>).onChange).toBe("function");
    });
  });

  it("注册表按宿主给的 id 登记（目录名 ≠ manifest.id 也能取回）", () => {
    const { a } = api();
    const m = a.module as Record<string, new (app: unknown, manifest: unknown) => never>;
    const manifest = { id: "nextcloud-sync-yanc", name: "Nextcloud sync YANC", version: "1.1.3" };
    const p1 = new m.Plugin(a.app, manifest) as unknown as {
      manifest: { id: string };
      addSettingTab(t: unknown): void;
      getSettingTabs(): unknown[];
      getCommands?(): unknown[];
    };
    // 宿主按目录名 obsidian-nextcloud-sync-yanc 登记（Obsidian 的 id 就是目录名）
    a.registry.add(p1 as never, "obsidian-nextcloud-sync-yanc");
    const got = a.registry.get("obsidian-nextcloud-sync-yanc");
    expect(got).toBe(p1 as never);
    // 设置页也要能被宿主的 settingsTabs 表查到（onload 之后才注册也要算）
    p1.addSettingTab({ name: "设置", display: () => undefined });
    expect(a.registry.settingsTabs.get("obsidian-nextcloud-sync-yanc")).toHaveLength(1);
    expect(p1.getSettingTabs()).toHaveLength(1);
  });

  it("app 上的容器/注册表齐备（插件会直接取用）", () => {
    const { a } = api();
    for (const key of ["vault", "workspace", "metadataCache", "fileManager", "commands",
      "embedRegistry", "viewRegistry", "plugins", "internalPlugins", "scope", "dom", "keymap"]) {
      expect((a.app as Record<string, unknown>)[key], `app.${key} 缺失`).toBeTruthy();
    }
    // internalPlugins 必须是事件源（否则插件 onload 里 on() 直接抛）
    expect(typeof (a.app.internalPlugins as unknown as { on: unknown }).on).toBe("function");
    expect(typeof (a.app.viewRegistry as unknown as { typeByExtension: unknown }).typeByExtension).toBe("function");
    const vr = a.app.viewRegistry as unknown as { typeByExtension(ext: string): string };
    expect(vr.typeByExtension("png")).toBe("png");
  });

  it("视图继承链与 Obsidian 一致（extends EditableFileView 的插件靠它）", () => {
    const { a } = api();
    const m = a.module as Record<string, new (...args: never[]) => unknown>;
    const leaf = { workspace: a.workspace } as never;
    const fv = new (m.FileView as new (l: never) => { canAcceptExtension(e: string): boolean })(leaf);
    expect(fv.canAcceptExtension("png")).toBe(false);
    const iv = new (m.ImageView as new (l: never) => { canAcceptExtension(e: string): boolean })(leaf);
    expect(iv.canAcceptExtension("png")).toBe(true);
    expect(iv).toBeInstanceOf(m.FileView);
    const tv = new (m.TextFileView as new (l: never) => unknown)(leaf);
    expect(tv).toBeInstanceOf(m.EditableFileView);
    // 工作区分区是真实类（插件用 instanceof 判断主区/浮动窗）
    expect(a.workspace.rootSplit).toBeInstanceOf(m.WorkspaceRoot);
    expect(a.workspace.rightSplit).toBeInstanceOf(m.WorkspaceRoot);
  });

  it("ColorComponent 能设置/读回颜色（含 RGB/HSL）", () => {
    const { a } = api();
    const m = a.module as Record<string, new (el: HTMLElement) => unknown>;
    const host = document.createElement("div");
    // ColorComponent 的方法用局部类型描述（避免 Record<string, unknown> 不可调用）
    const c = new m.ColorComponent(host) as unknown as {
      setValue(v: string): void;
      getValue(): string;
      setValueRgb(v: { r: number; g: number; b: number }): void;
      getValueRgb(): { r: number; g: number; b: number } | null;
      getValueHsl(): { h: number; s: number; l: number } | null;
    };
    c.setValue("#ff8800");
    expect(c.getValue()).toBe("#ff8800");
    c.setValueRgb({ r: 0, g: 128, b: 255 });
    expect(c.getValue()).toBe("#0080ff");
    expect(c.getValueRgb()).toEqual({ r: 0, g: 128, b: 255 });
    expect(typeof c.getValueHsl()).toBe("object");
    // 取色器应渲染出真实的 input 控件
    expect(host.querySelectorAll("input").length).toBeGreaterThanOrEqual(2);
  });

  it("displayTooltip 会在元素旁插入提示", () => {
    const { a } = api();
    const m = a.module as Record<string, (el: HTMLElement, text: string) => void>;
    const wrap = document.createElement("div");
    const btn = document.createElement("button");
    wrap.appendChild(btn);
    document.body.appendChild(wrap);
    m.displayTooltip(btn, "提示文字");
    expect(wrap.querySelector(".nf-tooltip")?.textContent).toBe("提示文字");
    wrap.remove();
  });

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
