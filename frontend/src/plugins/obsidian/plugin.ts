/**
 * Plugin 基类与插件侧注册 API。
 *
 * 关键设计：宿主上下文（host / 数据目录）挂在 app 对象上，由 shim 工厂注入。
 * 这样插件自己写的 `class X extends Plugin { constructor(app, manifest) { super(app, manifest) } }`
 * 与 Obsidian 完全一致，不需要为 noteforge 改任何一行插件代码。
 */

import { Component, Events, Platform, addIcon, debounce, setIcon } from "./events";
import type { TAbstractFile, TFile } from "./items";
import type { PluginManifest } from "./types";
import type { View, WorkspaceLeaf } from "./workspace";
import { currentBasesHost } from "./bases/registry";

export interface Command {
  id: string;
  name: string;
  icon?: string;
  mobileOnly?: boolean;
  repeatable?: boolean;
  callback?: () => unknown;
  checkCallback?: (checking: boolean) => boolean | void;
  editorCallback?: (editor: unknown, ctx: unknown) => boolean | void;
  editorCheckCallback?: (checking: boolean, editor: unknown, ctx: unknown) => boolean | void;
  hotkeys?: unknown[];
}

export interface PluginContext {
  /** 宿主给插件定的注册键（Obsidian 里就是插件目录名，未必等于 manifest.id）。 */
  registryKey?: string;
  host: import("./types").Host;
  /** 宿主插件注册表（命令/设置页/视图的汇总） */
  registry?: import("./index").PluginRegistry;
  /** 插件注册的编辑器补全器 */
  editorSuggests?: unknown[];
  /** 插件 id（数据目录 .obsidian/plugins/<id>/data.json） */
  id: string;
  /** 宿主提供的 CodeMirror 扩展收集器 */
  editorExtensions?: unknown[];
  /** Markdown 后处理器收集器 */
  postProcessors?: Map<string, (el: HTMLElement, ctx: { sourcePath: string; addChild(child: Component): void }) => unknown>;
  codeBlockProcessors?: Map<string, (source: string, el: HTMLElement, ctx: unknown) => unknown>;
}

const CTX = Symbol.for("noteforge.obsidian.ctx");

/** 由 shim 工厂在创建 app 时调用，把上下文挂到 app 上。 */
export function attachPluginContext(app: object, ctx: PluginContext): void {
  Object.defineProperty(app, CTX, { value: ctx, enumerable: false, configurable: true });
}

export function getPluginContext(app: unknown): PluginContext | undefined {
  if (!app || typeof app !== "object") return undefined;
  return (app as Record<symbol, unknown>)[CTX] as PluginContext | undefined;
}

/** Plugin 只需要 app 的少数能力，这里用结构类型避免与 index.ts 循环依赖。 */
export type ObsidianAppLike = object;

export abstract class PluginBase extends Component {
  manifest: PluginManifest;
  private ctx: PluginContext | undefined;
  private cliHandlers: Array<{ id: string; handler: unknown }> = [];
  /**
   * 内部命令表。名字带 nf 前缀是**必须的**：真实插件会在自己的实例上定义 `commands`
   * （BRAT 就这么干：`this.commands = new Te(this)`），同名会把这里覆盖成非数组对象，
   * 之后 getCommands() 展开它就抛 "this.commands is not iterable"。
   */
  private nfCommands: Command[] = [];
  private settingTabs: unknown[] = [];
  private ribbonEls: HTMLElement[] = [];
  private statusBarEls: HTMLElement[] = [];
  private disposers: Array<() => void> = [];
  private dataCache: unknown = null;

  app: ObsidianAppLike;

  constructor(app: ObsidianAppLike, manifest: PluginManifest) {
    super();
    this.app = app;
    this.manifest = manifest;
    this.ctx = getPluginContext(app);
  }

  get _ctx(): PluginContext {
    if (!this.ctx) {
      throw new Error(`插件 ${this.manifest.id} 未绑定宿主上下文（应由 shim 工厂创建）`);
    }
    return this.ctx;
  }

  /* ---------- 生命周期 ---------- */

  onload(): void {}

  onunload(): void {
    for (const d of this.disposers) {
      try {
        d();
      } catch (e) {
        console.error(`[obsidian-shim] ${this.manifest.id} 清理失败:`, e);
      }
    }
    this.disposers = [];
    for (const el of this.ribbonEls) el.remove();
    this.ribbonEls = [];
    for (const el of this.statusBarEls) el.remove();
    this.statusBarEls = [];
    this.nfCommands = [];
  }

  /* ---------- 工作区 ---------- */

  private ws(): Record<string, unknown> | undefined {
    return (this.app as unknown as { workspace?: Record<string, unknown> })?.workspace;
  }

  registerView(
    type: string,
    factory: (leaf: never) => unknown,
    opts?: { name?: string; icon?: string; ext?: string },
  ): void {
    (this.ws()?.registerView as ((t: string, f: unknown, o?: unknown) => void) | undefined)?.(type, factory, opts);
    // 同步登记到 app.viewRegistry，插件才会认为这个视图「已安装」
    const vr = (this.app as { viewRegistry?: { registerView?: (...a: unknown[]) => void } })?.viewRegistry;
    vr?.registerView?.(type, factory, opts);
  }

  registerEphemeralView(type: string, factory: (leaf: never) => unknown): void {
    this.registerView(type, factory);
  }

  /**
   * 注册一个 Bases 自定义视图（Obsidian 1.9+ 的 Bases 体系）。
   *
   * 这不是"多注册一个视图类型"那么简单：注册之后，这个 viewType 就成了
   * `.base` 文件里 `views[].type` 的一个可选值，用户能在布局菜单里选它。
   * 返回 false 表示该 viewId 已被占用（官方也是这个语义）。
   *
   * calendar-bases / social-archiver / media-extended 三个插件在 onload 里
   * 第一件事就是调它 —— 缺了这个方法，它们在求值阶段就抛
   * "Class extends value undefined"（BasesView 未定义）。
   */
  registerBasesView(viewId: string, registration: unknown): boolean {
    const host = currentBasesHost();
    if (!host) return false;
    const pluginId = (this.manifest as { id?: string } | undefined)?.id ?? "host";
    return host.register(viewId, registration as never, pluginId);
  }

  getLeavesOfType(type: string): unknown[] {
    const f = this.ws()?.getLeavesOfType as ((t: string) => unknown[]) | undefined;
    return f ? f.call(this.ws(), type) : [];
  }

  getLeaf(...args: unknown[]): unknown {
    const f = this.ws()?.getLeaf as ((...a: unknown[]) => unknown) | undefined;
    return f?.call(this.ws(), ...args);
  }

  getRightLeaf(split?: boolean): unknown {
    const f = this.ws()?.getRightLeaf as ((s?: boolean) => unknown) | undefined;
    return f?.call(this.ws(), split);
  }

  getActiveViewOfType<T>(type: string): T | null {
    const f = this.ws()?.getActiveViewOfType as ((t: string) => T | null) | undefined;
    return f ? f.call(this.ws(), type) : null;
  }

  revealLeaf(leaf: unknown): void {
    (this.ws()?.revealLeaf as ((l: unknown) => void) | undefined)?.call(this.ws(), leaf);
  }

  detachLeavesOfType(type: string): void {
    (this.ws()?.detachLeavesOfType as ((t: string) => void) | undefined)?.call(this.ws(), type);
  }

  setActiveLeaf(leaf: unknown, params?: unknown): void {
    (this.ws()?.setActiveLeaf as ((l: unknown, p?: unknown) => void) | undefined)?.call(this.ws(), leaf, params);
  }

  /* ---------- 命令 ---------- */

  addCommand(command: Command): Command {
    const full: Command = { ...command, id: `${this.manifest.id}:${command.id}` };
    this.nfCommands.push(full);
    // 同步到 app.commands，宿主（命令面板）直接枚举这份注册表
    const reg = (this.app as unknown as { commands?: { commands: Record<string, Command> } })?.commands;
    if (reg) reg.commands[full.id] = full;
    return full;
  }

  removeCommand(id: string): void {
    const full = `${this.manifest.id}:${id}`;
    this.nfCommands = this.nfCommands.filter((c: Command) => c.id !== full);
    const reg = (this.app as unknown as { commands?: { commands: Record<string, Command> } })?.commands;
    if (reg) delete reg.commands[full];
  }

  /** 供宿主读取（命令面板用）。 */
  getCommands(): Command[] {
    return [...this.nfCommands];
  }

  /* ---------- UI 部件 ---------- */

  addRibbonIcon(icon: string, title: string, callback: (evt: MouseEvent) => unknown): HTMLElement {
    const el = document.createElement("a");
    el.addClass?.("clickable-icon nf-plugin-ribbon-icon");
    el.setAttribute("aria-label", title);
    el.title = title;
    setIcon(el, icon);
    el.addEventListener("click", callback as EventListener);
    const host = (this.app as unknown as { workspace?: { containerEl?: HTMLElement } })?.workspace?.containerEl;
    host?.appendChild(el);
    this.ribbonEls.push(el);
    return el;
  }

  addStatusBarItem(): HTMLElement {
    const el = document.createElement("div");
    el.addClass?.("statusbar-item");
    const host =
      (this.app as unknown as { workspace?: { containerEl?: HTMLElement } })?.workspace?.containerEl ?? null;
    host?.appendChild(el);
    this.statusBarEls.push(el);
    return el;
  }

  addSettingTab(tab: unknown): void {
    this.settingTabs.push(tab);
    // 直接写 registry：插件可能在 onload 之后才注册设置页，宿主要能实时看到。
    // 键必须与宿主登记时一致（目录名），否则宿主按目录 id 找不到这个设置页 ——
    // 目录名与 manifest.id 不一致时（obsidian-nextcloud-sync-yanc 就属于这种）会漏。
    const key = this.ctx?.registryKey ?? this.manifest.id;
    this.ctx?.registry?.settingsTabs.get(key)?.push(tab);
  }

  getSettingTabs(): unknown[] {
    return [...this.settingTabs];
  }

  /* ---------- 注册 ---------- */

  registerEvent(ref: unknown): void {
    super.registerEvent(ref as never);
    this.disposers.push(() => (ref as { offref?: (r: unknown) => void })?.offref?.(ref));
  }

  registerDomEvent(el: EventTarget, type: string, cb: EventListener, options?: AddEventListenerOptions): void {
    el.addEventListener(type, cb, options);
    const off = () => el.removeEventListener(type, cb, options);
    this._domEvents.push(off);
    this.disposers.push(off);
  }

  registerInterval(id: number): number {
    this._intervals.push(id);
    const off = () => clearInterval(id);
    this.disposers.push(off);
    return id;
  }

  register(cb: () => unknown): void {
    const off = () => {
      void cb();
    };
    this.disposers.push(off);
  }

  registerEditorExtension(ext: unknown): void {
    this._ctx.editorExtensions?.push(ext);
    this.disposers.push(() => {
      const arr = this._ctx.editorExtensions;
      if (!arr) return;
      const i = arr.indexOf(ext);
      if (i >= 0) arr.splice(i, 1);
    });
  }

  /**
   * 声明「这些扩展名由我的视图接管」（Obsidian 1.x 起的老 API）。
   *
   * 插件靠它让自定义格式的文件点开时走自己的视图，例如 quadrant-chart 用
   * `registerExtensions(['mdx'], VIEW_TYPE_QUADRANT)` 把 .mdx 渲染成图表。
   * 原来这里是空实现（`void viewType`），宿主既不知道扩展名归属、也不会路由，
   * 结果 .mdx 被当成附件打开，只看到一坨 YAML。
   */
  /**
   * 注册 CLI 命令处理器（`obsidian <id> ...`）。
   * noteforge 没有命令行入口，登记后立刻回调一次让插件释放资源 ——
   * 不实现的话插件会在 onload 里直接抛 "registerCliHandler is not a function"。
   */
  registerCliHandler(id: string, handler: unknown): void {
    this.cliHandlers.push({ id, handler });
  }

  /** 已登记的 CLI 处理器（宿主若将来支持 CLI 可直接用）。 */
  getCliHandlers(): Array<{ id: string; handler: unknown }> {
    return [...this.cliHandlers];
  }

  registerExtensions(exts: unknown[], viewType: string): void {
    for (const e of exts) {
      const ext = String(e);
      this.registerEditorExtension(ext);
      const ws = this.ws();
      (ws?.registerExtension as ((e: string, v: string) => void) | undefined)?.(ext, viewType);
    }
  }

  /**
   * 撤销扩展名归属（官方 API，插件在 onunload 里调）。
   * 没有它插件卸载就抛 "unregisterExtensions is not a function"。
   */
  unregisterExtensions(exts: unknown[]): void {
    const ws = this.ws();
    for (const e of exts) {
      const ext = String(e).replace(/^\./, "").toLowerCase();
      (ws?.unregisterExtension as ((e: string) => void) | undefined)?.(ext);
    }
  }

  registerMarkdownPostProcessor(
    processor: (el: HTMLElement, ctx: { sourcePath: string; frontmatter?: unknown; addChild(child: Component): void }) => unknown,
    sortOrder = 0,
  ): unknown {
    const key = `${this.manifest.id}:pp:${sortOrder}`;
    this._ctx.postProcessors?.set(key, processor as never);
    return { key };
  }

  registerMarkdownCodeBlockProcessor(
    language: string,
    processor: (source: string, el: HTMLElement, ctx: unknown) => unknown,
    sortOrder = 0,
  ): unknown {
    const key = `${this.manifest.id}:cb:${sortOrder}:${language}`;
    this._ctx.codeBlockProcessors?.set(key, processor as never);
    return { key };
  }

  registerHoverLinkSource(_id: string, _info: unknown): void {}

  /** 注册编辑器补全器（EditorSuggest 子类）。 */
  registerEditorSuggest(suggestor: unknown): void {
    const arr = this.ctx?.editorSuggests;
    if (arr) {
      arr.push(suggestor);
      this.disposers.push(() => {
        const i = arr.indexOf(suggestor);
        if (i >= 0) arr.splice(i, 1);
      });
    }
  }

  /** 注册代码块预览（MarkdownCodeBlockProcessor 的旧名）。 */
  registerMarkdownPostProcessors(list: Array<(el: HTMLElement, ctx: unknown) => unknown>): void {
    list.forEach((fn, i) => this.registerMarkdownPostProcessor(fn as never, i));
  }

  registerObsidianProtocolHandler(_action: string, _handler: unknown): void {}

  onExternalSettingsChange(): void {}

  /* ---------- 数据 ---------- */

  private dataPath(): string {
    return `.obsidian/plugins/${this.manifest.id}/data.json`;
  }

  async loadData(): Promise<unknown> {
    try {
      const raw = await this._ctx.host.fs.read(this.dataPath());
      this.dataCache = JSON.parse(raw);
    } catch {
      this.dataCache = null;
    }
    return this.dataCache;
  }

  async saveData(data: unknown): Promise<void> {
    this.dataCache = data;
    const dir = `.obsidian/plugins/${this.manifest.id}`;
    try {
      await this._ctx.host.fs.mkdir(dir);
    } catch {
      /* 目录已存在 */
    }
    await this._ctx.host.fs.write(this.dataPath(), JSON.stringify(data, null, 2));
  }

  /** Obsidian 里这两个类型是 Plugin 的类型别名 */
  onloadAsync?: never;
}

/**
 * 导出的 Plugin：既能 `new`，又能被 ES5 老插件 `.call(this)` / `.apply(this, args)`。
 *
 * 背景：部分老插件用 ES5 IIFE 模式寄生（`var P = function(_super){
 *   function P(){ return _super !== null && _super.apply(this, arguments) || this; }
 *   ... P.prototype.onload = ...
 *   return P; }(obsidian.Plugin)`）。ES6 class 只能 new、不能 apply，
 * 会抛 "Class constructor cannot be invoked without 'new'"。真实 Obsidian 的
 * Plugin 在这些插件发布的年代是 ES5 函数，故这里做一层可调用包装保持兼容。
 *
 * 关键点：ES5 子类构造时 `this` 已按子类原型创建；我们把父类实例的自有字段
 * 搬到这个 `this` 上，使其同时具备「子类原型方法」与「Plugin 实例字段」。
 */
function PluginWrapper(this: unknown, ...args: unknown[]): unknown {
  // new 路径（ES6 子类 super 或宿主直接 new）：构造真类
  if (new.target) {
    return Reflect.construct(PluginBase, args, new.target);
  }
  // ES5 寄生路径：调用者是已分配好的子类 this
  const self = this as Record<string, unknown>;
  const instance = Reflect.construct(PluginBase, args) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(instance)) {
    if (key === "constructor") continue;
    const desc = Object.getOwnPropertyDescriptor(instance, key);
    if (desc) Object.defineProperty(self, key, desc);
  }
  return self;
}
// 原型指向真类：保证 `instanceof Plugin` 与原型方法可见
PluginWrapper.prototype = PluginBase.prototype;
Object.defineProperty(PluginWrapper, Symbol.hasInstance, {
  value(this: unknown, obj: unknown): boolean {
    return obj instanceof PluginBase;
  },
});
/** 供内部类型与其它模块按 Plugin 引用 */
type Plugin = PluginBase;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Plugin = PluginWrapper as unknown as (new (...a: any[]) => PluginBase) &
  (abstract new (...args: any[]) => PluginBase);

export { Plugin };

/** Obsidian 1.5+ 的 Plugin_2（旧名兼容） */
export class Plugin_2 extends Plugin {}

export type { TAbstractFile, TFile, View, WorkspaceLeaf, Events, Platform, addIcon, debounce };
